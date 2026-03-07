/**
 * Keap MCP Server - Main Entry Point
 * 
 * An MCP server for Keap CRM using a proxy architecture.
 * All API calls are delegated to a Make.com webhook that handles authentication.
 * 
 * TOOLS IMPLEMENTED:
 *   - V1 read-only list/get tools for common CRM resources
 *   - V2 create/update/delete tools for contacts, companies, notes, tasks, tags,
 *     opportunities, emails, email address status, and campaign sequence updates
 * 
 * Environment Variables:
 *   MAKE_WEBHOOK_URL - Required. The Make.com webhook URL for API execution.
 *   TRANSPORT - Optional. 'stdio' (default) or 'http'
 *   PORT - Optional. Port for HTTP transport (default: 3000)
 * 
 * @author 4Spot Consulting
 * @see https://4SpotConsulting.com
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

// =============================================================================
// Configuration
// =============================================================================

const SERVER_NAME = "keap-mcp-server";
const SERVER_VERSION = "1.0.0";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "";
const REQUEST_TIMEOUT = 30000;
const CHARACTER_LIMIT = 50000;

// =============================================================================
// Types
// =============================================================================

/**
 * Key-value pair format required by Make.com HTTP module
 */
interface MakeKeyValuePair {
  key: string;
  value: string | number | boolean;
}

interface MakeWebhookPayload {
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query_params?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
}

interface MakeWebhookResponse {
  success: boolean;
  status_code?: number;
  data?: unknown;
  error?: string;
  error_details?: unknown;
}

// =============================================================================
// Make.com Webhook Proxy Service
// =============================================================================

/**
 * Transform query parameters to Make.com's required Array of Key-Value Collections format.
 * Filters out undefined/null/empty values and returns an array like:
 * [{ key: "email", value: "x" }, { key: "limit", value: 10 }]
 * 
 * @param params - Flat object with query parameters
 * @returns Array of key-value pairs (empty array if no valid params)
 */
function transformQueryParamsToKeyValueArray(
  params?: Record<string, string | number | boolean | undefined>
): MakeKeyValuePair[] {
  if (!params) return [];

  const result: MakeKeyValuePair[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      result.push({ key, value });
    }
  }

  return result;
}

/**
 * Send request to Make.com webhook for Keap API execution
 */
async function sendToMakeWebhook(payload: MakeWebhookPayload): Promise<MakeWebhookResponse> {
  if (!MAKE_WEBHOOK_URL) {
    return {
      success: false,
      error: "MAKE_WEBHOOK_URL environment variable is not configured.",
      error_details: {
        hint: "Export MAKE_WEBHOOK_URL=https://hook.make.com/your-webhook-id before starting the server"
      }
    };
  }

  // Transform query_params to Make.com's required Array of Key-Value Collections format
  const cleanedPayload = {
    path: payload.path,
    method: payload.method,
    query_params: transformQueryParamsToKeyValueArray(payload.query_params),
    body: payload.body
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(cleanedPayload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const contentType = response.headers.get("content-type");
    let responseData: unknown;

    if (contentType?.includes("application/json")) {
      responseData = await response.json();
    } else {
      responseData = await response.text();
    }

    if (!response.ok) {
      return {
        success: false,
        status_code: response.status,
        error: `Make.com webhook returned status ${response.status}`,
        error_details: responseData
      };
    }

    // Handle response format from Make.com
    if (typeof responseData === "object" && responseData !== null) {
      const data = responseData as Record<string, unknown>;

      if (data.error || data.success === false) {
        return {
          success: false,
          status_code: (data.status_code as number) || response.status,
          error: (data.error as string) || "Keap API returned an error",
          error_details: data.error_details || data
        };
      }

      return {
        success: true,
        status_code: (data.status_code as number) || response.status,
        data: data.data !== undefined ? data.data : data
      };
    }

    return {
      success: true,
      status_code: response.status,
      data: responseData
    };

  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return {
          success: false,
          error: `Request timed out after ${REQUEST_TIMEOUT / 1000} seconds`
        };
      }
      return {
        success: false,
        error: `Failed to connect to Make.com webhook: ${error.message}`
      };
    }
    return {
      success: false,
      error: "Unknown error occurred"
    };
  }
}

/**
 * Format response for MCP tool output
 */
function formatToolResponse(response: MakeWebhookResponse): { success: boolean; content: string } {
  if (!response.success) {
    const errorMsg = response.error || "Unknown error";
    const details = response.error_details
      ? `\n\nDetails: ${JSON.stringify(response.error_details, null, 2)}`
      : "";
    return { success: false, content: `Error: ${errorMsg}${details}` };
  }

  let content = JSON.stringify(response.data, null, 2);

  if (content.length > CHARACTER_LIMIT) {
    content = content.substring(0, CHARACTER_LIMIT) +
      `\n\n... [Truncated. Total: ${content.length} chars. Use pagination for more.]`;
  }

  return { success: true, content };
}

/**
 * Normalize a string or string[] into a comma-delimited string
 */
function normalizeCommaList(value?: string | string[]): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value.join(",") : value;
}

// =============================================================================
// Zod Schemas - Contacts (V1 API)
// =============================================================================

/**
 * GET /v1/contacts - List Contacts
 * Verified parameters from Keap V1 OpenAPI documentation
 */
const ListContactsInputSchema = z.object({
  email: z.string()
    .optional()
    .describe("Optional email address to query on"),

  given_name: z.string()
    .optional()
    .describe("Optional first name or forename to query on"),

  family_name: z.string()
    .optional()
    .describe("Optional last name or surname to query on"),

  order: z.enum(["id", "date_created", "last_updated", "name", "firstName", "email"])
    .optional()
    .describe("Attribute to order items by"),

  order_direction: z.enum(["ASCENDING", "DESCENDING"])
    .optional()
    .describe("How to order the data i.e. ascending (A-Z) or descending (Z-A)"),

  since: z.string()
    .optional()
    .describe("Date to start searching from on LastUpdated ex. 2017-01-01T22:17:59.039Z"),

  until: z.string()
    .optional()
    .describe("Date to search to on LastUpdated ex. 2017-01-01T22:17:59.039Z"),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return"),

  optional_properties: z.array(z.string())
    .optional()
    .describe("Extra fields to include: custom_fields, lead_source_id, job_title, tag_ids, etc.")
}).strict();

type ListContactsInput = z.infer<typeof ListContactsInputSchema>;

/**
 * GET /v1/contacts/{id} - Get Single Contact
 */
const GetContactInputSchema = z.object({
  id: z.number()
    .int()
    .positive()
    .describe("Contact ID (path parameter)"),

  optional_properties: z.array(z.string())
    .optional()
    .describe("Extra fields to include in response")
}).strict();

type GetContactInput = z.infer<typeof GetContactInputSchema>;



// =============================================================================
// Zod Schemas - Orders (V1 API)
// =============================================================================

/**
 * GET /v1/orders - List Orders
 * Verified parameters from Keap V1 OpenAPI documentation
 * NOTE: No order_direction parameter - V1 always sorts dates most recent first
 */
const ListOrdersInputSchema = z.object({
  contact_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Returns orders for the provided contact id"),

  product_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Returns orders containing the provided product id"),

  paid: z.boolean()
    .optional()
    .describe("Sets paid status of items to return"),

  order: z.enum(["order_date", "update_date"])
    .optional()
    .describe("Attribute to order items by. Default is creation_date. Dates ordered most recent first."),

  since: z.string()
    .optional()
    .describe("Date to start searching from ex. 2017-01-01T22:17:59.039Z"),

  until: z.string()
    .optional()
    .describe("Date to search to ex. 2017-01-01T22:17:59.039Z"),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return")
}).strict();

type ListOrdersInput = z.infer<typeof ListOrdersInputSchema>;

/**
 * GET /v1/orders/{orderId} - Get Single Order
 */
const GetOrderInputSchema = z.object({
  order_id: z.number()
    .int()
    .positive()
    .describe("Order ID (path parameter)")
}).strict();

type GetOrderInput = z.infer<typeof GetOrderInputSchema>;

// =============================================================================
// Create MCP Server and Register Tools
// =============================================================================

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION
});

// ---------------------------------------------------------------------------
// TOOL 1: keap_list_contacts
// API: GET /v1/contacts
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_contacts",
  `List and search contacts in Keap CRM.

API Endpoint: GET /v1/contacts

Args:
  - email (string, optional): Email address to query on
  - given_name (string, optional): First name to query on
  - family_name (string, optional): Last name to query on
  - order (enum, optional): Sort by - 'id', 'date_created', 'last_updated', 'name', 'firstName', 'email'
  - order_direction (enum, optional): 'ASCENDING' or 'DESCENDING'
  - since (string, optional): Filter on LastUpdated (ISO 8601)
  - until (string, optional): Filter on LastUpdated (ISO 8601)
  - limit (integer, optional): Number of results to return
  - offset (integer, optional): Number of results to skip
  - optional_properties (array, optional): Extra fields like 'custom_fields', 'tag_ids'

Returns:
  { contacts: [...], count, next, previous }

Examples:
  - Search by email: { "email": "john@example.com" }
  - Search by name: { "given_name": "John" }
  - Paginated: { "limit": 50, "offset": 100 }`,
  ListContactsInputSchema.shape,
  async (params: ListContactsInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      email: params.email,
      given_name: params.given_name,
      family_name: params.family_name,
      order: params.order,
      order_direction: params.order_direction,
      since: params.since,
      until: params.until,
      limit: params.limit,
      offset: params.offset
    };

    if (params.optional_properties && params.optional_properties.length > 0) {
      query_params.optional_properties = params.optional_properties.join(",");
    }

    const response = await sendToMakeWebhook({
      path: "/v1/contacts",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 2: keap_get_contact
// API: GET /v1/contacts/{id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_get_contact",
  `Retrieve a single contact by ID from Keap CRM.

API Endpoint: GET /v1/contacts/{id}

Args:
  - id (integer, required): Contact ID
  - optional_properties (array, optional): Extra fields to include

Returns:
  Full contact object with all requested fields.

Examples:
  - Basic: { "id": 123 }
  - With extra fields: { "id": 123, "optional_properties": ["custom_fields", "tag_ids"] }`,
  GetContactInputSchema.shape,
  async (params: GetContactInput) => {
    const query_params: Record<string, string | undefined> = {};

    if (params.optional_properties && params.optional_properties.length > 0) {
      query_params.optional_properties = params.optional_properties.join(",");
    }

    const response = await sendToMakeWebhook({
      path: `/v1/contacts/${params.id}`,
      method: "GET",
      query_params: Object.keys(query_params).length > 0 ? query_params : undefined
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);



// ---------------------------------------------------------------------------
// TOOL 4: keap_list_orders
// API: GET /v1/orders
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_orders",
  `List orders in Keap CRM with optional filtering.

API Endpoint: GET /v1/orders

Order status values: DRAFT, SENT, VIEWED, PAID

Args:
  - contact_id (integer, optional): Filter by contact ID
  - product_id (integer, optional): Filter by product ID
  - paid (boolean, optional): Filter by paid status
  - order (enum, optional): Sort by - 'order_date' or 'update_date' (default: creation_date)
  - since (string, optional): Date to start searching from (ISO 8601)
  - until (string, optional): Date to search to (ISO 8601)
  - limit (integer, optional): Number of results to return
  - offset (integer, optional): Number of results to skip

Note: Dates are always sorted most recent first (no order_direction param in V1).

Returns:
  { orders: [...], count, next, previous }

Examples:
  - All orders: {}
  - By contact: { "contact_id": 123 }
  - Paid only: { "paid": true }
  - Date range: { "since": "2024-01-01T00:00:00.000Z", "until": "2024-12-31T23:59:59.999Z" }`,
  ListOrdersInputSchema.shape,
  async (params: ListOrdersInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      contact_id: params.contact_id,
      product_id: params.product_id,
      paid: params.paid,
      order: params.order,
      since: params.since,
      until: params.until,
      limit: params.limit,
      offset: params.offset
    };

    const response = await sendToMakeWebhook({
      path: "/v1/orders",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 5: keap_get_order
// API: GET /v1/orders/{orderId}
// ---------------------------------------------------------------------------
server.tool(
  "keap_get_order",
  `Retrieve a single order by ID from Keap CRM.

API Endpoint: GET /v1/orders/{orderId}

Args:
  - order_id (integer, required): Order ID

Returns:
  Full order object with items, shipping info, payment details.

Examples:
  - { "order_id": 12345 }`,
  GetOrderInputSchema.shape,
  async (params: GetOrderInput) => {
    const response = await sendToMakeWebhook({
      path: `/v1/orders/${params.order_id}`,
      method: "GET"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// =============================================================================
// Zod Schemas - Products (V1 API)
// =============================================================================

/**
 * GET /v1/products - List Products
 * Verified parameters from Keap V1 OpenAPI documentation
 */
const ListProductsInputSchema = z.object({
  active: z.boolean()
    .optional()
    .describe("Sets status of items to return (true for active, false for inactive)"),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return")
}).strict();

type ListProductsInput = z.infer<typeof ListProductsInputSchema>;

/**
 * GET /v1/products/{product_id} - Get Single Product
 */
const GetProductInputSchema = z.object({
  product_id: z.number()
    .int()
    .positive()
    .describe("Product ID (path parameter)")
}).strict();

type GetProductInput = z.infer<typeof GetProductInputSchema>;

// =============================================================================
// Zod Schemas - Notes (V1 API)
// =============================================================================

/**
 * GET /v1/notes - List Notes
 * Verified parameters from Keap V1 OpenAPI documentation
 */
const ListNotesInputSchema = z.object({
  contact_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Filter based on the contact id assigned to the note"),

  user_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Filter based on the user id assigned to the note"),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return")
}).strict();

type ListNotesInput = z.infer<typeof ListNotesInputSchema>;



// =============================================================================
// Zod Schemas - Tasks (V1 API)
// =============================================================================

/**
 * GET /v1/tasks - List Tasks
 * Verified parameters from Keap V1 OpenAPI documentation
 */
const ListTasksInputSchema = z.object({
  contact_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Filter by contact ID"),

  user_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Filter by user ID"),

  completed: z.boolean()
    .optional()
    .describe("Sets completed status of items to return"),

  has_due_date: z.boolean()
    .optional()
    .describe("Filter by whether task has a due date"),

  order: z.string()
    .optional()
    .describe("Attribute to order items by"),

  since: z.string()
    .optional()
    .describe("Date to start searching from ex. 2017-01-01T22:17:59.039Z"),

  until: z.string()
    .optional()
    .describe("Date to search to ex. 2017-01-01T22:17:59.039Z"),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return")
}).strict();

type ListTasksInput = z.infer<typeof ListTasksInputSchema>;

// ---------------------------------------------------------------------------
// TOOL 6: keap_list_products
// API: GET /v1/products
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_products",
  `List products in Keap CRM.

API Endpoint: GET /v1/products

Args:
  - active (boolean, optional): Filter by active status (true/false)
  - limit (integer, optional): Number of results to return
  - offset (integer, optional): Number of results to skip

Returns:
  { products: [...], count, next, previous }`,
  ListProductsInputSchema.shape,
  async (params: ListProductsInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      active: params.active,
      limit: params.limit,
      offset: params.offset
    };

    const response = await sendToMakeWebhook({
      path: "/v1/products",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 7: keap_get_product
// API: GET /v1/products/{product_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_get_product",
  `Retrieve a single product by ID from Keap CRM.

API Endpoint: GET /v1/products/{product_id}

Args:
  - product_id (integer, required): Product ID

Returns:
  Full product object with pricing, subscription details, etc.`,
  GetProductInputSchema.shape,
  async (params: GetProductInput) => {
    const response = await sendToMakeWebhook({
      path: `/v1/products/${params.product_id}`,
      method: "GET"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 8: keap_list_notes
// API: GET /v1/notes
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_notes",
  `List notes in Keap CRM with optional filtering.

API Endpoint: GET /v1/notes

Args:
  - contact_id (integer, optional): Filter by contact ID
  - user_id (integer, optional): Filter by user ID who created the note
  - limit (integer, optional): Number of results to return
  - offset (integer, optional): Number of results to skip`,
  ListNotesInputSchema.shape,
  async (params: ListNotesInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      contact_id: params.contact_id,
      user_id: params.user_id,
      limit: params.limit,
      offset: params.offset
    };

    const response = await sendToMakeWebhook({
      path: "/v1/notes",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);



// ---------------------------------------------------------------------------
// TOOL 10: keap_list_tasks
// API: GET /v1/tasks
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_tasks",
  `List tasks in Keap CRM with optional filtering.

API Endpoint: GET /v1/tasks

Args:
  - contact_id (integer, optional): Filter by contact ID
  - user_id (integer, optional): Filter by assigned user ID
  - completed (boolean, optional): Filter by completed status
  - has_due_date (boolean, optional): Filter by whether task has a due date
  - since (string, optional): Date to start searching from
  - until (string, optional): Date to search to
  - limit (integer, optional): Number of results`,
  ListTasksInputSchema.shape,
  async (params: ListTasksInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      contact_id: params.contact_id,
      user_id: params.user_id,
      completed: params.completed,
      has_due_date: params.has_due_date,
      order: params.order,
      since: params.since,
      until: params.until,
      limit: params.limit,
      offset: params.offset
    };

    const response = await sendToMakeWebhook({
      path: "/v1/tasks",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// =============================================================================
// Zod Schemas - Batch 3 (Companies, Tags, Tasks V1)
// =============================================================================



/**
 * GET /v1/companies - List Companies
 * Verified from Keap V1 OpenAPI documentation
 */
const ListCompaniesInputSchema = z.object({
  company_name: z.string()
    .optional()
    .describe("Optional company name to query on"),

  order: z.enum(["id", "date_created", "name", "email"])
    .optional()
    .describe("Attribute to order items by"),

  order_direction: z.enum(["ASCENDING", "DESCENDING"])
    .optional()
    .describe("How to order the data i.e. ascending (A-Z) or descending (Z-A)"),

  optional_properties: z.array(z.string())
    .optional()
    .describe("Extra fields to include: notes, fax_number, custom_fields, etc."),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return")
}).strict();

type ListCompaniesInput = z.infer<typeof ListCompaniesInputSchema>;

/**
 * GET /v1/companies/{companyId} - Get Single Company
 * Verified from Keap V1 OpenAPI documentation
 */
const GetCompanyInputSchema = z.object({
  company_id: z.number()
    .int()
    .positive()
    .describe("Company ID (path parameter)"),

  optional_properties: z.array(z.string())
    .optional()
    .describe("Extra fields to include: notes, fax_number, custom_fields, etc.")
}).strict();

type GetCompanyInput = z.infer<typeof GetCompanyInputSchema>;

/**
 * GET /v1/tags - List Tags
 * Verified from Keap V1 OpenAPI documentation
 */
const ListTagsInputSchema = z.object({
  name: z.string()
    .optional()
    .describe("Filter for tags with a specific name"),

  category: z.number()
    .int()
    .positive()
    .optional()
    .describe("Category Id of tags to filter by"),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return")
}).strict();

type ListTagsInput = z.infer<typeof ListTagsInputSchema>;





// ---------------------------------------------------------------------------
// TOOL 12: keap_list_companies
// API: GET /v1/companies
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_companies",
  `List companies in Keap CRM with optional filtering.

API Endpoint: GET /v1/companies

Args:
  - company_name (string, optional): Company name to query on
  - order (enum, optional): Sort by - 'id', 'date_created', 'name', 'email'
  - limit (integer, optional): Number of results to return
  - offset (integer, optional): Number of results to skip`,
  ListCompaniesInputSchema.shape,
  async (params: ListCompaniesInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      company_name: params.company_name,
      order: params.order,
      order_direction: params.order_direction,
      limit: params.limit,
      offset: params.offset
    };

    if (params.optional_properties && params.optional_properties.length > 0) {
      query_params.optional_properties = params.optional_properties.join(",");
    }

    const response = await sendToMakeWebhook({
      path: "/v1/companies",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 13: keap_get_company
// API: GET /v1/companies/{companyId}
// ---------------------------------------------------------------------------
server.tool(
  "keap_get_company",
  `Retrieve a single company by ID from Keap CRM.

API Endpoint: GET /v1/companies/{companyId}

Args:
  - company_id (integer, required): Company ID
  - optional_properties (array, optional): Extra fields like 'notes', 'fax_number'`,
  GetCompanyInputSchema.shape,
  async (params: GetCompanyInput) => {
    const query_params: Record<string, string | undefined> = {};

    if (params.optional_properties && params.optional_properties.length > 0) {
      query_params.optional_properties = params.optional_properties.join(",");
    }

    const response = await sendToMakeWebhook({
      path: `/v1/companies/${params.company_id}`,
      method: "GET",
      query_params: Object.keys(query_params).length > 0 ? query_params : undefined
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 14: keap_list_tags
// API: GET /v1/tags
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_tags",
  `List tags defined in Keap CRM with optional filtering.

API Endpoint: GET /v1/tags

Args:
  - name (string, optional): Filter for tags with a specific name
  - category (integer, optional): Category Id of tags to filter by
  - limit (integer, optional): Number of results to return`,
  ListTagsInputSchema.shape,
  async (params: ListTagsInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      name: params.name,
      category: params.category,
      limit: params.limit,
      offset: params.offset
    };

    const response = await sendToMakeWebhook({
      path: "/v1/tags",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);



// =============================================================================
// Zod Schemas - Batch 4 (Opportunities, Users, Update Contact)
// =============================================================================

/**
 * GET /v1/opportunities - List Opportunities
 * Verified from Keap V1 OpenAPI documentation
 */
const ListOpportunitiesInputSchema = z.object({
  search_term: z.string()
    .optional()
    .describe("Search opportunities matching contact given_name, family_name, or title"),

  stage_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Returns opportunities for the provided stage id"),

  user_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Returns opportunities for the provided user id"),

  order: z.enum(["next_action", "opportunity_name", "contact_name", "date_created"])
    .optional()
    .describe("Attribute to order items by"),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return")
}).strict();

type ListOpportunitiesInput = z.infer<typeof ListOpportunitiesInputSchema>;

/**
 * GET /v1/opportunities/{opportunityId} - Get Single Opportunity
 * Verified from Keap V1 OpenAPI documentation
 */
const GetOpportunityInputSchema = z.object({
  opportunity_id: z.number()
    .int()
    .positive()
    .describe("Opportunity ID (path parameter)"),

  optional_properties: z.array(z.string())
    .optional()
    .describe("Extra fields to include, e.g. 'custom_fields'")
}).strict();

type GetOpportunityInput = z.infer<typeof GetOpportunityInputSchema>;



/**
 * GET /v1/users - List Users
 * Verified from Keap V1 OpenAPI documentation
 */
const ListUsersInputSchema = z.object({
  include_inactive: z.boolean()
    .optional()
    .describe("Include users that are Inactive in results, defaults to TRUE"),

  include_partners: z.boolean()
    .optional()
    .describe("Include partner users in results, defaults to TRUE"),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return")
}).strict();

type ListUsersInput = z.infer<typeof ListUsersInputSchema>;

/**
 * GET /v2/users/{user_id} - Get Single User
 * ⚠️ V2 API — there is no GET user-by-ID endpoint in V1
 */
const GetUserInputSchema = z.object({
  user_id: z.string()
    .describe("User ID (path parameter, string in V2 API)")
}).strict();

type GetUserInput = z.infer<typeof GetUserInputSchema>;

// ---------------------------------------------------------------------------
// TOOL 16: keap_list_opportunities
// API: GET /v1/opportunities
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_opportunities",
  `List opportunities in Keap CRM with optional filtering.

API Endpoint: GET /v1/opportunities

Args:
  - search_term (string, optional): Search by contact name, company, or title
  - stage_id (integer, optional): Filter by pipeline stage ID
  - user_id (integer, optional): Filter by assigned user ID
  - limit (integer, optional): Number of results`,
  ListOpportunitiesInputSchema.shape,
  async (params: ListOpportunitiesInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      search_term: params.search_term,
      stage_id: params.stage_id,
      user_id: params.user_id,
      order: params.order,
      limit: params.limit,
      offset: params.offset
    };

    const response = await sendToMakeWebhook({
      path: "/v1/opportunities",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 17: keap_get_opportunity
// API: GET /v1/opportunities/{opportunityId}
// ---------------------------------------------------------------------------
server.tool(
  "keap_get_opportunity",
  `Retrieve a single opportunity by ID from Keap CRM.

API Endpoint: GET /v1/opportunities/{opportunityId}

Args:
  - opportunity_id (integer, required): Opportunity ID
  - optional_properties (array, optional): Extra fields like 'custom_fields'`,
  GetOpportunityInputSchema.shape,
  async (params: GetOpportunityInput) => {
    const query_params: Record<string, string | undefined> = {};

    if (params.optional_properties && params.optional_properties.length > 0) {
      query_params.optional_properties = params.optional_properties.join(",");
    }

    const response = await sendToMakeWebhook({
      path: `/v1/opportunities/${params.opportunity_id}`,
      method: "GET",
      query_params: Object.keys(query_params).length > 0 ? query_params : undefined
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);



// ---------------------------------------------------------------------------
// TOOL 19: keap_list_users
// API: GET /v1/users
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_users",
  `List users in Keap CRM.

API Endpoint: GET /v1/users

Args:
  - include_inactive (boolean, optional): Include inactive users
  - include_partners (boolean, optional): Include partner users
  - limit (integer, optional): Number of results`,
  ListUsersInputSchema.shape,
  async (params: ListUsersInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      include_inactive: params.include_inactive,
      include_partners: params.include_partners,
      limit: params.limit,
      offset: params.offset
    };

    const response = await sendToMakeWebhook({
      path: "/v1/users",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 20: keap_get_user
// API: GET /v2/users/{user_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_get_user",
  `Retrieve a single user by ID from Keap CRM.

API Endpoint: GET /v2/users/{user_id}
⚠️ Note: Uses V2 API.

Args:
  - user_id (string, required): User ID`,
  GetUserInputSchema.shape,
  async (params: GetUserInput) => {
    const response = await sendToMakeWebhook({
      path: `/v2/users/${params.user_id}`,
      method: "GET"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// =============================================================================
// Zod Schemas - Batch 5: Final GET-Only Tools (Files, Campaigns, Appointments)
// =============================================================================

/**
 * GET /v1/files - List Files
 * Verified from Keap V1 OpenAPI documentation
 */
const ListFilesInputSchema = z.object({
  contact_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Filter based on Contact Id"),

  name: z.string()
    .optional()
    .describe("Filter files based on name, supports wildcards (e.g. 'report*')"),

  type: z.enum([
    "Application", "Image", "Fax", "Attachment", "Ticket", "Contact",
    "DigitalProduct", "Import", "Hidden", "WebForm", "StyledCart",
    "ReSampledImage", "TemplateThumbnail", "Funnel", "LogoThumbnail",
    "Unlayer", "BrandingCenterLogo"
  ])
    .optional()
    .describe("Filter based on the type of file"),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return")
}).strict();

type ListFilesInput = z.infer<typeof ListFilesInputSchema>;

/**
 * GET /v1/files/{fileId} - Get Single File
 * Verified from Keap V1 OpenAPI documentation
 */
const GetFileInputSchema = z.object({
  file_id: z.number()
    .int()
    .positive()
    .describe("File ID (path parameter)"),

  optional_properties: z.array(z.string())
    .optional()
    .describe("Extra fields to include, e.g. 'file_data' for content")
}).strict();

type GetFileInput = z.infer<typeof GetFileInputSchema>;

/**
 * GET /v1/transactions - List Transactions
 * Verified from Keap V1 OpenAPI documentation
 * NOTE: This endpoint is deprecated but currently functional.
 */
const ListTransactionsInputSchema = z.object({
  contact_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Returns transactions for the provided contact id"),

  since: z.string()
    .optional()
    .describe("Date to start searching from ex. 2017-01-01T00:00:00.000Z"),

  until: z.string()
    .optional()
    .describe("Date to search to ex. 2017-01-01T00:00:00.000Z"),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return")
}).strict();

type ListTransactionsInput = z.infer<typeof ListTransactionsInputSchema>;

/**
 * GET /v1/campaigns - List Campaigns
 * Verified from Keap V1 OpenAPI documentation
 */
const ListCampaignsInputSchema = z.object({
  search_text: z.string()
    .optional()
    .describe("Optional text to search campaigns"),

  order: z.enum([
    "id", "name", "published_date", "completed_contact_count",
    "active_contact_count", "date_created", "last_updated", "category", "status"
  ])
    .optional()
    .describe("Attribute to order items by"),

  order_direction: z.enum(["ASCENDING", "DESCENDING"])
    .optional()
    .describe("How to order the data i.e. ascending (A-Z) or descending (Z-A)"),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return")
}).strict();

type ListCampaignsInput = z.infer<typeof ListCampaignsInputSchema>;

/**
 * GET /v1/campaigns/{campaignId} - Get Single Campaign
 * Verified from Keap V1 OpenAPI documentation
 */
const GetCampaignInputSchema = z.object({
  campaign_id: z.number()
    .int()
    .positive()
    .describe("Campaign ID (path parameter)"),

  optional_properties: z.array(z.string())
    .optional()
    .describe("Extra fields to include, e.g. 'goals', 'sequences'")
}).strict();

type GetCampaignInput = z.infer<typeof GetCampaignInputSchema>;

/**
 * GET /v1/appointments - List Appointments
 * Verified from Keap V1 OpenAPI documentation
 */
const ListAppointmentsInputSchema = z.object({
  contact_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Optionally find appointments with a contact"),

  since: z.string()
    .optional()
    .describe("Date to start searching from ex. 2017-01-01T00:00:00.000Z"),

  until: z.string()
    .optional()
    .describe("Date to search to ex. 2017-01-01T00:00:00.000Z"),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return")
}).strict();

type ListAppointmentsInput = z.infer<typeof ListAppointmentsInputSchema>;

/**
 * GET /v1/appointments/{appointmentId} - Get Single Appointment
 * Verified from Keap V1 OpenAPI documentation
 */
const GetAppointmentInputSchema = z.object({
  appointment_id: z.number()
    .int()
    .positive()
    .describe("Appointment ID (path parameter)")
}).strict();

type GetAppointmentInput = z.infer<typeof GetAppointmentInputSchema>;

// ---------------------------------------------------------------------------
// TOOL 21: keap_list_files
// API: GET /v1/files
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_files",
  `List files in Keap CRM with optional filtering.

API Endpoint: GET /v1/files

Args:
  - contact_id (integer, optional): Filter by contact ID
  - name (string, optional): Filter by name, supports wildcards
  - type (enum, optional): File type (Application, Image, Fax, Attachment, etc.)
  - limit (integer, optional): Number of results to return`,
  ListFilesInputSchema.shape,
  async (params: ListFilesInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      contact_id: params.contact_id,
      name: params.name,
      type: params.type,
      limit: params.limit,
      offset: params.offset
    };

    const response = await sendToMakeWebhook({
      path: "/v1/files",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 22: keap_get_file
// API: GET /v1/files/{fileId}
// ---------------------------------------------------------------------------
server.tool(
  "keap_get_file",
  `Retrieve metadata for a specific file in Keap CRM.

API Endpoint: GET /v1/files/{fileId}

Args:
  - file_id (integer, required): File ID
  - optional_properties (array, optional): Extra fields like 'file_data'`,
  GetFileInputSchema.shape,
  async (params: GetFileInput) => {
    const query_params: Record<string, string | undefined> = {};

    if (params.optional_properties && params.optional_properties.length > 0) {
      query_params.optional_properties = params.optional_properties.join(",");
    }

    const response = await sendToMakeWebhook({
      path: `/v1/files/${params.file_id}`,
      method: "GET",
      query_params: Object.keys(query_params).length > 0 ? query_params : undefined
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 23: keap_list_transactions
// API: GET /v1/transactions
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_transactions",
  `List transactions in Keap CRM with optional filtering.

API Endpoint: GET /v1/transactions
NOTE: This endpoint is deprecated but currently functional.

Args:
  - contact_id (integer, optional): Filter by contact ID
  - since (string, optional): Date to start searching from
  - until (string, optional): Date to search to
  - limit (integer, optional): Number of results to return`,
  ListTransactionsInputSchema.shape,
  async (params: ListTransactionsInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      contact_id: params.contact_id,
      since: params.since,
      until: params.until,
      limit: params.limit,
      offset: params.offset
    };

    const response = await sendToMakeWebhook({
      path: "/v1/transactions",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 24: keap_list_campaigns
// API: GET /v1/campaigns
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_campaigns",
  `List marketing automation campaigns in Keap CRM.

API Endpoint: GET /v1/campaigns

Args:
  - search_text (string, optional): Text to search campaigns
  - order (enum, optional): Sort by 'id', 'name', 'status', etc.
  - limit (integer, optional): Number of results to return`,
  ListCampaignsInputSchema.shape,
  async (params: ListCampaignsInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      search_text: params.search_text,
      order: params.order,
      order_direction: params.order_direction,
      limit: params.limit,
      offset: params.offset
    };

    const response = await sendToMakeWebhook({
      path: "/v1/campaigns",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 25: keap_get_campaign
// API: GET /v1/campaigns/{campaignId}
// ---------------------------------------------------------------------------
server.tool(
  "keap_get_campaign",
  `Retrieve a single campaign by ID from Keap CRM.

API Endpoint: GET /v1/campaigns/{campaignId}

Args:
  - campaign_id (integer, required): Campaign ID
  - optional_properties (array, optional): Extra fields like 'goals', 'sequences'`,
  GetCampaignInputSchema.shape,
  async (params: GetCampaignInput) => {
    const query_params: Record<string, string | undefined> = {};

    if (params.optional_properties && params.optional_properties.length > 0) {
      query_params.optional_properties = params.optional_properties.join(",");
    }

    const response = await sendToMakeWebhook({
      path: `/v1/campaigns/${params.campaign_id}`,
      method: "GET",
      query_params: Object.keys(query_params).length > 0 ? query_params : undefined
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 26: keap_list_appointments
// API: GET /v1/appointments
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_appointments",
  `List appointments in Keap CRM with optional filtering.

API Endpoint: GET /v1/appointments

Args:
  - contact_id (integer, optional): Find appointments with a specific contact
  - since (string, optional): Date to start searching from
  - until (string, optional): Date to search to
  - limit (integer, optional): Number of results to return`,
  ListAppointmentsInputSchema.shape,
  async (params: ListAppointmentsInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      contact_id: params.contact_id,
      since: params.since,
      until: params.until,
      limit: params.limit,
      offset: params.offset
    };

    const response = await sendToMakeWebhook({
      path: "/v1/appointments",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 27: keap_get_appointment
// API: GET /v1/appointments/{appointmentId}
// ---------------------------------------------------------------------------
server.tool(
  "keap_get_appointment",
  `Retrieve a single appointment by ID from Keap CRM.

API Endpoint: GET /v1/appointments/{appointmentId}

Args:
  - appointment_id (integer, required): Appointment ID`,
  GetAppointmentInputSchema.shape,
  async (params: GetAppointmentInput) => {
    const response = await sendToMakeWebhook({
      path: `/v1/appointments/${params.appointment_id}`,
      method: "GET"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// =============================================================================
// Zod Schemas - Batch 6: Final Tools (Emails, Pipeline Stages)
// =============================================================================

/**
 * GET /v1/emails - List Emails
 * Verified from Keap V1 OpenAPI documentation
 */
const ListEmailsInputSchema = z.object({
  contact_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Optional Contact Id to find Emails for"),

  email: z.string()
    .optional()
    .describe("Optional email address to query on"),

  since_sent_date: z.string()
    .optional()
    .describe("Emails sent since this date (ISO 8601)."),

  until_sent_date: z.string()
    .optional()
    .describe("Emails sent until this date (ISO 8601)"),

  ordered: z.boolean()
    .optional()
    .describe("Set to false to turn off ORDER BY (may improve performance)"),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe("Sets a total of items to return"),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe("Sets a beginning range of items to return")
}).strict();

type ListEmailsInput = z.infer<typeof ListEmailsInputSchema>;

/**
 * GET /v1/emails/{id} - Get Single Email
 * Verified from Keap V1 OpenAPI documentation
 */
const GetEmailInputSchema = z.object({
  email_id: z.number()
    .int()
    .positive()
    .describe("Email record ID (path parameter)")
}).strict();

type GetEmailInput = z.infer<typeof GetEmailInputSchema>;

/**
 * GET /v1/opportunity/stage_pipeline - List Opportunity Stage Pipeline
 * Verified from Keap V1 OpenAPI documentation
 */
const ListOpportunityStagesInputSchema = z.object({}).strict();

type ListOpportunityStagesInput = z.infer<typeof ListOpportunityStagesInputSchema>;


// ---------------------------------------------------------------------------
// TOOL 28: keap_list_emails
// API: GET /v1/emails
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_emails",
  `List email records in Keap CRM.

API Endpoint: GET /v1/emails

Args:
  - contact_id (integer, optional): Filter by contact ID
  - email (string, optional): Filter by email address
  - since_sent_date (string, optional): ISO 8601 date
  - until_sent_date (string, optional): ISO 8601 date
  - limit (integer, optional): Number of results`,
  ListEmailsInputSchema.shape,
  async (params: ListEmailsInput) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      contact_id: params.contact_id,
      email: params.email,
      since_sent_date: params.since_sent_date,
      until_sent_date: params.until_sent_date,
      ordered: params.ordered,
      limit: params.limit,
      offset: params.offset
    };

    const response = await sendToMakeWebhook({
      path: "/v1/emails",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 29: keap_get_email
// API: GET /v1/emails/{id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_get_email",
  `Retrieve a single email record by ID from Keap CRM.

API Endpoint: GET /v1/emails/{id}

Args:
  - email_id (integer, required): Email record ID`,
  GetEmailInputSchema.shape,
  async (params: GetEmailInput) => {
    const response = await sendToMakeWebhook({
      path: `/v1/emails/${params.email_id}`,
      method: "GET"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 30: keap_list_opportunity_stages
// API: GET /v1/opportunity/stage_pipeline
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_opportunity_stages",
  `List all opportunity stages with pipeline details.

API Endpoint: GET /v1/opportunity/stage_pipeline

No parameters required. Useful for finding stage_id values for opportunities.`,
  ListOpportunityStagesInputSchema.shape,
  async (_params: ListOpportunityStagesInput) => {
    const response = await sendToMakeWebhook({
      path: "/v1/opportunity/stage_pipeline",
      method: "GET"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// =============================================================================
// Zod Schemas - V2 Write Operations (Selected Resources)
// =============================================================================

const CommaListSchema = z.union([z.string(), z.array(z.string())]).optional();

const ContactFieldsSchema = z.object({
  addresses: z.array(z.record(z.any())).optional().describe("Address objects"),
  company: z.record(z.any()).optional().describe("Company reference"),
  origin: z.string().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  website: z.string().optional(),
  anniversary_date: z.string().optional(),
  birth_date: z.string().optional(),
  contact_type: z.string().optional(),
  custom_fields: z.array(z.record(z.any())).optional(),
  email_addresses: z.array(z.record(z.any())).optional(),
  family_name: z.string().optional(),
  fax_numbers: z.array(z.record(z.any())).optional(),
  given_name: z.string().optional(),
  job_title: z.string().optional(),
  leadsource_id: z.string().optional(),
  middle_name: z.string().optional(),
  owner_id: z.string().optional(),
  phone_numbers: z.array(z.record(z.any())).optional(),
  preferred_locale: z.string().optional(),
  preferred_name: z.string().optional(),
  referral_code: z.string().optional(),
  social_accounts: z.array(z.record(z.any())).optional(),
  source_type: z.string().optional(),
  spouse_name: z.string().optional(),
  time_zone: z.string().optional(),
  utm_parameters: z.record(z.any()).optional()
}).passthrough();

const CreateContactV2InputSchema = z.object({
  fields: CommaListSchema.describe("Optional fields to include in the response (comma-delimited or array)"),
  body: ContactFieldsSchema.describe("Contact fields to create")
}).strict();

type CreateContactV2Input = z.infer<typeof CreateContactV2InputSchema>;

const UpdateContactV2InputSchema = z.object({
  contact_id: z.string().describe("Contact ID (path parameter)"),
  update_mask: CommaListSchema.describe("Optional list of fields to update (comma-delimited or array)"),
  fields: CommaListSchema.describe("Optional fields to include in the response (comma-delimited or array)"),
  body: ContactFieldsSchema.describe("Contact fields to update")
}).strict();

type UpdateContactV2Input = z.infer<typeof UpdateContactV2InputSchema>;

const DeleteContactV2InputSchema = z.object({
  contact_id: z.string().describe("Contact ID (path parameter)")
}).strict();

type DeleteContactV2Input = z.infer<typeof DeleteContactV2InputSchema>;

const CompanyFieldsSchema = z.object({
  address: z.record(z.any()).optional(),
  notes: z.string().optional(),
  website: z.string().optional(),
  company_name: z.string().optional(),
  custom_fields: z.array(z.record(z.any())).optional(),
  email_address: z.record(z.any()).optional(),
  fax_number: z.record(z.any()).optional(),
  phone_number: z.record(z.any()).optional()
}).passthrough();

const CreateCompanyV2InputSchema = z.object({
  body: CompanyFieldsSchema.describe("Company fields to create")
}).strict();

type CreateCompanyV2Input = z.infer<typeof CreateCompanyV2InputSchema>;

const UpdateCompanyV2InputSchema = z.object({
  company_id: z.string().describe("Company ID (path parameter)"),
  update_mask: CommaListSchema.describe("Optional list of fields to update (comma-delimited or array)"),
  body: CompanyFieldsSchema.describe("Company fields to update")
}).strict();

type UpdateCompanyV2Input = z.infer<typeof UpdateCompanyV2InputSchema>;

const DeleteCompanyV2InputSchema = z.object({
  company_id: z.string().describe("Company ID (path parameter)")
}).strict();

type DeleteCompanyV2Input = z.infer<typeof DeleteCompanyV2InputSchema>;

const CreateNoteBodySchema = z.object({
  title: z.string().optional(),
  text: z.string().optional(),
  type: z.string().optional(),
  user_id: z.string().describe("User ID (required)"),
  is_pinned: z.boolean().optional()
}).passthrough();

const UpdateNoteBodySchema = z.object({
  title: z.string().optional(),
  text: z.string().optional(),
  type: z.string().optional(),
  user_id: z.string().describe("User ID (required)"),
  is_pinned: z.boolean().optional(),
  contact_id: z.string().optional().describe("Optional new contact ID for the note")
}).passthrough();

const CreateNoteV2InputSchema = z.object({
  contact_id: z.string().describe("Contact ID (path parameter)"),
  body: CreateNoteBodySchema.describe("Note fields to create")
}).strict();

type CreateNoteV2Input = z.infer<typeof CreateNoteV2InputSchema>;

const UpdateNoteV2InputSchema = z.object({
  contact_id: z.string().describe("Contact ID (path parameter)"),
  note_id: z.string().describe("Note ID (path parameter)"),
  update_mask: CommaListSchema.describe("Optional list of fields to update (comma-delimited or array)"),
  body: UpdateNoteBodySchema.describe("Note fields to update")
}).strict();

type UpdateNoteV2Input = z.infer<typeof UpdateNoteV2InputSchema>;

const DeleteNoteV2InputSchema = z.object({
  contact_id: z.string().describe("Contact ID (path parameter)"),
  note_id: z.string().describe("Note ID (path parameter)")
}).strict();

type DeleteNoteV2Input = z.infer<typeof DeleteNoteV2InputSchema>;

const CreateTaskBodySchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
  priority: z.string().optional(),
  completed: z.boolean().optional(),
  completion_time: z.string().optional(),
  due_time: z.string().optional(),
  remind_time_mins: z.number().int().optional(),
  assigned_to_user_id: z.string().describe("Assigned user ID (required)"),
  contact_id: z.string().optional()
}).passthrough();

const UpdateTaskBodySchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
  priority: z.string().optional(),
  completed: z.boolean().optional(),
  completion_time: z.string().optional(),
  due_time: z.string().optional(),
  remind_time_mins: z.number().int().optional(),
  assigned_to_user_id: z.string().optional(),
  contact_id: z.string().optional()
}).passthrough();

const CreateTaskV2InputSchema = z.object({
  body: CreateTaskBodySchema.describe("Task fields to create")
}).strict();

type CreateTaskV2Input = z.infer<typeof CreateTaskV2InputSchema>;

const UpdateTaskV2InputSchema = z.object({
  task_id: z.string().describe("Task ID (path parameter)"),
  update_mask: CommaListSchema.describe("Optional list of fields to update (comma-delimited or array)"),
  body: UpdateTaskBodySchema.describe("Task fields to update")
}).strict();

type UpdateTaskV2Input = z.infer<typeof UpdateTaskV2InputSchema>;

const DeleteTaskV2InputSchema = z.object({
  task_id: z.string().describe("Task ID (path parameter)")
}).strict();

type DeleteTaskV2Input = z.infer<typeof DeleteTaskV2InputSchema>;

const TagBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  category: z.record(z.any()).optional()
}).passthrough();

const CreateTagV2InputSchema = z.object({
  body: TagBodySchema.describe("Tag fields to create")
}).strict();

type CreateTagV2Input = z.infer<typeof CreateTagV2InputSchema>;

const UpdateTagV2InputSchema = z.object({
  tag_id: z.string().describe("Tag ID (path parameter)"),
  update_mask: CommaListSchema.describe("Optional list of fields to update (comma-delimited or array)"),
  body: TagBodySchema.describe("Tag fields to update")
}).strict();

type UpdateTagV2Input = z.infer<typeof UpdateTagV2InputSchema>;

const DeleteTagV2InputSchema = z.object({
  tag_id: z.string().describe("Tag ID (path parameter)")
}).strict();

type DeleteTagV2Input = z.infer<typeof DeleteTagV2InputSchema>;

const OpportunityBaseBodySchema = z.object({
  next_action_time: z.string().optional(),
  next_action_notes: z.string().optional(),
  opportunity_notes: z.string().optional(),
  estimated_close_time: z.string().optional(),
  include_in_forecast: z.boolean().optional(),
  projected_revenue_low: z.number().optional(),
  projected_revenue_high: z.number().optional(),
  contact_id: z.string().optional(),
  stage_id: z.string().optional(),
  user_id: z.string().optional(),
  custom_fields: z.array(z.record(z.any())).optional(),
  affiliate_id: z.string().optional()
}).passthrough();

const CreateOpportunityBodySchema = OpportunityBaseBodySchema.extend({
  opportunity_title: z.string().describe("Opportunity title (required)")
});

const UpdateOpportunityBodySchema = OpportunityBaseBodySchema.extend({
  opportunity_title: z.string().optional()
});

const CreateOpportunityV2InputSchema = z.object({
  body: CreateOpportunityBodySchema.describe("Opportunity fields to create")
}).strict();

type CreateOpportunityV2Input = z.infer<typeof CreateOpportunityV2InputSchema>;

const UpdateOpportunityV2InputSchema = z.object({
  opportunity_id: z.string().describe("Opportunity ID (path parameter)"),
  update_mask: CommaListSchema.describe("Optional list of fields to update (comma-delimited or array)"),
  body: UpdateOpportunityBodySchema.describe("Opportunity fields to update")
}).strict();

type UpdateOpportunityV2Input = z.infer<typeof UpdateOpportunityV2InputSchema>;

const DeleteOpportunityV2InputSchema = z.object({
  opportunity_id: z.string().describe("Opportunity ID (path parameter)")
}).strict();

type DeleteOpportunityV2Input = z.infer<typeof DeleteOpportunityV2InputSchema>;

const EmailRecordBodySchema = z.object({
  subject: z.string().optional(),
  headers: z.string().optional(),
  contact_id: z.string().optional(),
  sent_to_address: z.string().describe("Recipient email address (required)"),
  sent_to_cc_address_list: z.array(z.string()).optional(),
  sent_to_bcc_address_list: z.array(z.string()).optional(),
  sent_from_address: z.string().optional(),
  sent_from_reply_address: z.string().optional(),
  sent_time: z.string().optional(),
  received_time: z.string().optional(),
  opened_time: z.string().optional(),
  clicked_time: z.string().optional(),
  plain_content: z.string().optional().describe("Base64 encoded text"),
  html_content: z.string().optional().describe("Base64 encoded HTML"),
  original_provider: z.enum(["UNKNOWN", "INFUSIONSOFT", "MICROSOFT", "GOOGLE"]).optional(),
  original_provider_id: z.string().optional(),
  provider_source_id: z.string().optional()
}).passthrough();

const CreateEmailV2InputSchema = z.object({
  body: EmailRecordBodySchema.describe("Email record fields to create")
}).strict();

type CreateEmailV2Input = z.infer<typeof CreateEmailV2InputSchema>;

const EmailSendBodySchema = z.object({
  contacts: z.array(z.string()).describe("Contact IDs to receive the email (required)"),
  subject: z.string().describe("Email subject (required)"),
  attachments: z.array(z.record(z.any())).optional(),
  user_id: z.string().describe("User ID sending the email (required)"),
  html_content: z.string().optional().describe("Base64 encoded HTML content"),
  plain_content: z.string().optional().describe("Base64 encoded text content"),
  address_field: z.string().optional()
}).passthrough();

const SendEmailV2InputSchema = z.object({
  body: EmailSendBodySchema.describe("Email send request")
}).strict();

type SendEmailV2Input = z.infer<typeof SendEmailV2InputSchema>;

const DeleteEmailV2InputSchema = z.object({
  email_id: z.string().describe("Email record ID (path parameter)")
}).strict();

type DeleteEmailV2Input = z.infer<typeof DeleteEmailV2InputSchema>;

const EmailAddressStatusInputSchema = z.object({
  email: z.string().describe("Email address")
}).strict();

type EmailAddressStatusInput = z.infer<typeof EmailAddressStatusInputSchema>;

const UpdateEmailAddressBodySchema = z.object({
  opted_in: z.boolean().describe("Opt-in status (required)"),
  reason: z.string().describe("Reason for the status change (required)")
}).passthrough();

const UpdateEmailAddressStatusInputSchema = z.object({
  email: z.string().describe("Email address"),
  body: UpdateEmailAddressBodySchema.describe("Email address status update")
}).strict();

type UpdateEmailAddressStatusInput = z.infer<typeof UpdateEmailAddressStatusInputSchema>;

const CampaignSequenceContactsBodySchema = z.object({
  contact_ids: z.array(z.string()).describe("Contact IDs to add/remove")
}).passthrough();

const AddContactsToCampaignSequenceInputSchema = z.object({
  campaign_id: z.string().describe("Campaign ID (path parameter)"),
  sequence_id: z.string().describe("Sequence ID (path parameter)"),
  body: CampaignSequenceContactsBodySchema.describe("Contacts to add")
}).strict();

type AddContactsToCampaignSequenceInput = z.infer<typeof AddContactsToCampaignSequenceInputSchema>;

const RemoveContactsFromCampaignSequenceInputSchema = z.object({
  campaign_id: z.string().describe("Campaign ID (path parameter)"),
  sequence_id: z.string().describe("Sequence ID (path parameter)"),
  body: CampaignSequenceContactsBodySchema.describe("Contacts to remove")
}).strict();

type RemoveContactsFromCampaignSequenceInput = z.infer<typeof RemoveContactsFromCampaignSequenceInputSchema>;

const UpdateUserBodySchema = z.object({
  address: z.record(z.any()).optional(),
  title: z.string().optional(),
  website: z.string().optional(),
  company_name: z.string().optional(),
  email_address: z.record(z.any()).optional(),
  family_name: z.string().optional(),
  fax_numbers: z.array(z.record(z.any())).optional(),
  given_name: z.string().optional(),
  phone_numbers: z.array(z.record(z.any())).optional(),
  time_zone: z.string().optional()
}).passthrough();

const UpdateUserV2InputSchema = z.object({
  user_id: z.string().describe("User ID (path parameter)"),
  update_mask: CommaListSchema.describe("Optional list of fields to update (comma-delimited or array)"),
  body: UpdateUserBodySchema.describe("User fields to update")
}).strict();

type UpdateUserV2Input = z.infer<typeof UpdateUserV2InputSchema>;

const ListUserGroupsV2InputSchema = z.object({}).strict();
type ListUserGroupsV2Input = z.infer<typeof ListUserGroupsV2InputSchema>;

const GetUserGroupV2InputSchema = z.object({
  user_group_id: z.string().describe("User group ID (path parameter)")
}).strict();

type GetUserGroupV2Input = z.infer<typeof GetUserGroupV2InputSchema>;

const ListWebformsV2InputSchema = z.object({
  filter: z.string().optional().describe("Filter string (e.g., name==MyForm)"),
  page_token: z.string().optional().describe("Page token"),
  order_by: z.string().optional().describe("Order by field and direction"),
  page_size: z.number().int().min(0).max(1000).optional().describe("Results per page")
}).strict();

type ListWebformsV2Input = z.infer<typeof ListWebformsV2InputSchema>;

const GetWebformDataV2InputSchema = z.object({
  webform_id: z.string().describe("Webform ID (path parameter)")
}).strict();

type GetWebformDataV2Input = z.infer<typeof GetWebformDataV2InputSchema>;

// ---------------------------------------------------------------------------
// TOOL 31: keap_create_contact
// API: POST /v2/contacts
// ---------------------------------------------------------------------------
server.tool(
  "keap_create_contact",
  `Create a new contact in Keap (V2).

API Endpoint: POST /v2/contacts

Args:
  - fields (string|array, optional): Fields to include in response
  - body (object, required): Contact fields (email_addresses or phone_numbers required)

Returns:
  Created contact object.`,
  CreateContactV2InputSchema.shape,
  async (params: CreateContactV2Input) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      fields: normalizeCommaList(params.fields)
    };

    const response = await sendToMakeWebhook({
      path: "/v2/contacts",
      method: "POST",
      query_params,
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 32: keap_update_contact
// API: PATCH /v2/contacts/{contact_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_update_contact",
  `Update an existing contact in Keap (V2).

API Endpoint: PATCH /v2/contacts/{contact_id}

Args:
  - contact_id (string, required): Contact ID
  - update_mask (string|array, optional): Fields to update
  - fields (string|array, optional): Fields to include in response
  - body (object, required): Contact fields to update

Returns:
  Updated contact object.`,
  UpdateContactV2InputSchema.shape,
  async (params: UpdateContactV2Input) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      update_mask: normalizeCommaList(params.update_mask),
      fields: normalizeCommaList(params.fields)
    };

    const response = await sendToMakeWebhook({
      path: `/v2/contacts/${params.contact_id}`,
      method: "PATCH",
      query_params,
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 33: keap_delete_contact
// API: DELETE /v2/contacts/{contact_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_delete_contact",
  `Delete a contact in Keap (V2).

API Endpoint: DELETE /v2/contacts/{contact_id}

Args:
  - contact_id (string, required): Contact ID

Returns:
  204 No Content on success.`,
  DeleteContactV2InputSchema.shape,
  async (params: DeleteContactV2Input) => {
    const response = await sendToMakeWebhook({
      path: `/v2/contacts/${params.contact_id}`,
      method: "DELETE"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 34: keap_create_company
// API: POST /v2/companies
// ---------------------------------------------------------------------------
server.tool(
  "keap_create_company",
  `Create a new company in Keap (V2).

API Endpoint: POST /v2/companies

Args:
  - body (object, required): Company fields

Returns:
  Created company object.`,
  CreateCompanyV2InputSchema.shape,
  async (params: CreateCompanyV2Input) => {
    const response = await sendToMakeWebhook({
      path: "/v2/companies",
      method: "POST",
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 35: keap_update_company
// API: PATCH /v2/companies/{company_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_update_company",
  `Update an existing company in Keap (V2).

API Endpoint: PATCH /v2/companies/{company_id}

Args:
  - company_id (string, required): Company ID
  - update_mask (string|array, optional): Fields to update
  - body (object, required): Company fields to update

Returns:
  Updated company object.`,
  UpdateCompanyV2InputSchema.shape,
  async (params: UpdateCompanyV2Input) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      update_mask: normalizeCommaList(params.update_mask)
    };

    const response = await sendToMakeWebhook({
      path: `/v2/companies/${params.company_id}`,
      method: "PATCH",
      query_params,
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 36: keap_delete_company
// API: DELETE /v2/companies/{company_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_delete_company",
  `Delete a company in Keap (V2).

API Endpoint: DELETE /v2/companies/{company_id}

Args:
  - company_id (string, required): Company ID

Returns:
  204 No Content on success.`,
  DeleteCompanyV2InputSchema.shape,
  async (params: DeleteCompanyV2Input) => {
    const response = await sendToMakeWebhook({
      path: `/v2/companies/${params.company_id}`,
      method: "DELETE"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 37: keap_create_note
// API: POST /v2/contacts/{contact_id}/notes
// ---------------------------------------------------------------------------
server.tool(
  "keap_create_note",
  `Create a note for a contact in Keap (V2).

API Endpoint: POST /v2/contacts/{contact_id}/notes

Args:
  - contact_id (string, required): Contact ID
  - body (object, required): Note fields (user_id required)

Returns:
  Created note object.`,
  CreateNoteV2InputSchema.shape,
  async (params: CreateNoteV2Input) => {
    const response = await sendToMakeWebhook({
      path: `/v2/contacts/${params.contact_id}/notes`,
      method: "POST",
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 38: keap_update_note
// API: PATCH /v2/contacts/{contact_id}/notes/{note_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_update_note",
  `Update a note for a contact in Keap (V2).

API Endpoint: PATCH /v2/contacts/{contact_id}/notes/{note_id}

Args:
  - contact_id (string, required): Contact ID
  - note_id (string, required): Note ID
  - update_mask (string|array, optional): Fields to update
  - body (object, required): Note fields to update (user_id required)

Returns:
  Updated note object.`,
  UpdateNoteV2InputSchema.shape,
  async (params: UpdateNoteV2Input) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      update_mask: normalizeCommaList(params.update_mask)
    };

    const response = await sendToMakeWebhook({
      path: `/v2/contacts/${params.contact_id}/notes/${params.note_id}`,
      method: "PATCH",
      query_params,
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 39: keap_delete_note
// API: DELETE /v2/contacts/{contact_id}/notes/{note_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_delete_note",
  `Delete a note for a contact in Keap (V2).

API Endpoint: DELETE /v2/contacts/{contact_id}/notes/{note_id}

Args:
  - contact_id (string, required): Contact ID
  - note_id (string, required): Note ID

Returns:
  204 No Content on success.`,
  DeleteNoteV2InputSchema.shape,
  async (params: DeleteNoteV2Input) => {
    const response = await sendToMakeWebhook({
      path: `/v2/contacts/${params.contact_id}/notes/${params.note_id}`,
      method: "DELETE"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 40: keap_create_task
// API: POST /v2/tasks
// ---------------------------------------------------------------------------
server.tool(
  "keap_create_task",
  `Create a task in Keap (V2).

API Endpoint: POST /v2/tasks

Args:
  - body (object, required): Task fields (assigned_to_user_id required)

Returns:
  Created task object.`,
  CreateTaskV2InputSchema.shape,
  async (params: CreateTaskV2Input) => {
    const response = await sendToMakeWebhook({
      path: "/v2/tasks",
      method: "POST",
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 41: keap_update_task
// API: PATCH /v2/tasks/{task_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_update_task",
  `Update a task in Keap (V2).

API Endpoint: PATCH /v2/tasks/{task_id}

Args:
  - task_id (string, required): Task ID
  - update_mask (string|array, optional): Fields to update
  - body (object, required): Task fields to update

Returns:
  Updated task object.`,
  UpdateTaskV2InputSchema.shape,
  async (params: UpdateTaskV2Input) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      update_mask: normalizeCommaList(params.update_mask)
    };

    const response = await sendToMakeWebhook({
      path: `/v2/tasks/${params.task_id}`,
      method: "PATCH",
      query_params,
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 42: keap_delete_task
// API: DELETE /v2/tasks/{task_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_delete_task",
  `Delete a task in Keap (V2).

API Endpoint: DELETE /v2/tasks/{task_id}

Args:
  - task_id (string, required): Task ID

Returns:
  204 No Content on success.`,
  DeleteTaskV2InputSchema.shape,
  async (params: DeleteTaskV2Input) => {
    const response = await sendToMakeWebhook({
      path: `/v2/tasks/${params.task_id}`,
      method: "DELETE"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 43: keap_create_tag
// API: POST /v2/tags
// ---------------------------------------------------------------------------
server.tool(
  "keap_create_tag",
  `Create a tag in Keap (V2).

API Endpoint: POST /v2/tags

Args:
  - body (object, required): Tag fields

Returns:
  Created tag object.`,
  CreateTagV2InputSchema.shape,
  async (params: CreateTagV2Input) => {
    const response = await sendToMakeWebhook({
      path: "/v2/tags",
      method: "POST",
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 44: keap_update_tag
// API: PATCH /v2/tags/{tag_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_update_tag",
  `Update a tag in Keap (V2).

API Endpoint: PATCH /v2/tags/{tag_id}

Args:
  - tag_id (string, required): Tag ID
  - update_mask (string|array, optional): Fields to update
  - body (object, required): Tag fields to update

Returns:
  Updated tag object.`,
  UpdateTagV2InputSchema.shape,
  async (params: UpdateTagV2Input) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      update_mask: normalizeCommaList(params.update_mask)
    };

    const response = await sendToMakeWebhook({
      path: `/v2/tags/${params.tag_id}`,
      method: "PATCH",
      query_params,
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 45: keap_delete_tag
// API: DELETE /v2/tags/{tag_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_delete_tag",
  `Delete a tag in Keap (V2).

API Endpoint: DELETE /v2/tags/{tag_id}

Args:
  - tag_id (string, required): Tag ID

Returns:
  204 No Content on success.`,
  DeleteTagV2InputSchema.shape,
  async (params: DeleteTagV2Input) => {
    const response = await sendToMakeWebhook({
      path: `/v2/tags/${params.tag_id}`,
      method: "DELETE"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 46: keap_create_opportunity
// API: POST /v2/opportunities
// ---------------------------------------------------------------------------
server.tool(
  "keap_create_opportunity",
  `Create an opportunity in Keap (V2).

API Endpoint: POST /v2/opportunities

Args:
  - body (object, required): Opportunity fields (opportunity_title required)

Returns:
  Created opportunity object.`,
  CreateOpportunityV2InputSchema.shape,
  async (params: CreateOpportunityV2Input) => {
    const response = await sendToMakeWebhook({
      path: "/v2/opportunities",
      method: "POST",
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 47: keap_update_opportunity
// API: PATCH /v2/opportunities/{opportunity_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_update_opportunity",
  `Update an opportunity in Keap (V2).

API Endpoint: PATCH /v2/opportunities/{opportunity_id}

Args:
  - opportunity_id (string, required): Opportunity ID
  - update_mask (string|array, optional): Fields to update
  - body (object, required): Opportunity fields to update

Returns:
  Updated opportunity object.`,
  UpdateOpportunityV2InputSchema.shape,
  async (params: UpdateOpportunityV2Input) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      update_mask: normalizeCommaList(params.update_mask)
    };

    const response = await sendToMakeWebhook({
      path: `/v2/opportunities/${params.opportunity_id}`,
      method: "PATCH",
      query_params,
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 48: keap_delete_opportunity
// API: DELETE /v2/opportunities/{opportunity_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_delete_opportunity",
  `Delete an opportunity in Keap (V2).

API Endpoint: DELETE /v2/opportunities/{opportunity_id}

Args:
  - opportunity_id (string, required): Opportunity ID

Returns:
  204 No Content on success.`,
  DeleteOpportunityV2InputSchema.shape,
  async (params: DeleteOpportunityV2Input) => {
    const response = await sendToMakeWebhook({
      path: `/v2/opportunities/${params.opportunity_id}`,
      method: "DELETE"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 49: keap_create_email
// API: POST /v2/emails
// ---------------------------------------------------------------------------
server.tool(
  "keap_create_email",
  `Create an email record in Keap (V2).

API Endpoint: POST /v2/emails

Args:
  - body (object, required): Email record fields (sent_to_address required)

Returns:
  Created email record.`,
  CreateEmailV2InputSchema.shape,
  async (params: CreateEmailV2Input) => {
    const response = await sendToMakeWebhook({
      path: "/v2/emails",
      method: "POST",
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 50: keap_send_email
// API: POST /v2/emails:send
// ---------------------------------------------------------------------------
server.tool(
  "keap_send_email",
  `Send an email to contacts in Keap (V2).

API Endpoint: POST /v2/emails:send

Args:
  - body (object, required): Email send request (contacts, subject, user_id required)

Returns:
  202 Accepted on success.`,
  SendEmailV2InputSchema.shape,
  async (params: SendEmailV2Input) => {
    const response = await sendToMakeWebhook({
      path: "/v2/emails:send",
      method: "POST",
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 51: keap_delete_email
// API: DELETE /v2/emails/{id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_delete_email",
  `Delete an email record in Keap (V2).

API Endpoint: DELETE /v2/emails/{id}

Args:
  - email_id (string, required): Email record ID

Returns:
  204 No Content on success.`,
  DeleteEmailV2InputSchema.shape,
  async (params: DeleteEmailV2Input) => {
    const response = await sendToMakeWebhook({
      path: `/v2/emails/${params.email_id}`,
      method: "DELETE"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 52: keap_get_email_address_status
// API: GET /v2/emailAddresses/{email}/status
// ---------------------------------------------------------------------------
server.tool(
  "keap_get_email_address_status",
  `Retrieve email address status in Keap (V2).

API Endpoint: GET /v2/emailAddresses/{email}/status

Args:
  - email (string, required): Email address (URL-encode '@' as '%40' if needed)

Returns:
  Email address status object.`,
  EmailAddressStatusInputSchema.shape,
  async (params: EmailAddressStatusInput) => {
    const response = await sendToMakeWebhook({
      path: `/v2/emailAddresses/${params.email}/status`,
      method: "GET"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 53: keap_update_email_address_status
// API: PATCH /v2/emailAddresses/{email}/status
// ---------------------------------------------------------------------------
server.tool(
  "keap_update_email_address_status",
  `Update email address status in Keap (V2).

API Endpoint: PATCH /v2/emailAddresses/{email}/status

Args:
  - email (string, required): Email address (URL-encode '@' as '%40' if needed)
  - body (object, required): { opted_in, reason }

Returns:
  Updated email address status object.`,
  UpdateEmailAddressStatusInputSchema.shape,
  async (params: UpdateEmailAddressStatusInput) => {
    const response = await sendToMakeWebhook({
      path: `/v2/emailAddresses/${params.email}/status`,
      method: "PATCH",
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 54: keap_add_contacts_to_campaign_sequence
// API: POST /v2/campaigns/{campaign_id}/sequences/{sequence_id}:addContacts
// ---------------------------------------------------------------------------
server.tool(
  "keap_add_contacts_to_campaign_sequence",
  `Add contacts to a campaign sequence in Keap (V2).

API Endpoint: POST /v2/campaigns/{campaign_id}/sequences/{sequence_id}:addContacts

Args:
  - campaign_id (string, required)
  - sequence_id (string, required)
  - body (object, required): { contact_ids: [...] }

Returns:
  Map of contact IDs to results.`,
  AddContactsToCampaignSequenceInputSchema.shape,
  async (params: AddContactsToCampaignSequenceInput) => {
    const response = await sendToMakeWebhook({
      path: `/v2/campaigns/${params.campaign_id}/sequences/${params.sequence_id}:addContacts`,
      method: "POST",
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 55: keap_remove_contacts_from_campaign_sequence
// API: POST /v2/campaigns/{campaign_id}/sequences/{sequence_id}:removeContacts
// ---------------------------------------------------------------------------
server.tool(
  "keap_remove_contacts_from_campaign_sequence",
  `Remove contacts from a campaign sequence in Keap (V2).

API Endpoint: POST /v2/campaigns/{campaign_id}/sequences/{sequence_id}:removeContacts

Args:
  - campaign_id (string, required)
  - sequence_id (string, required)
  - body (object, required): { contact_ids: [...] }

Returns:
  Map of contact IDs to results.`,
  RemoveContactsFromCampaignSequenceInputSchema.shape,
  async (params: RemoveContactsFromCampaignSequenceInput) => {
    const response = await sendToMakeWebhook({
      path: `/v2/campaigns/${params.campaign_id}/sequences/${params.sequence_id}:removeContacts`,
      method: "POST",
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 56: keap_update_user
// API: PATCH /v2/users/{user_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_update_user",
  `Update a user in Keap (V2).

API Endpoint: PATCH /v2/users/{user_id}

Args:
  - user_id (string, required): User ID
  - update_mask (string|array, optional): Fields to update
  - body (object, required): User fields to update

Returns:
  Updated user object.`,
  UpdateUserV2InputSchema.shape,
  async (params: UpdateUserV2Input) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      update_mask: normalizeCommaList(params.update_mask)
    };

    const response = await sendToMakeWebhook({
      path: `/v2/users/${params.user_id}`,
      method: "PATCH",
      query_params,
      body: params.body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 57: keap_list_user_groups
// API: GET /v2/userGroups
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_user_groups",
  `List user groups in Keap (V2).

API Endpoint: GET /v2/userGroups

No parameters required.`,
  ListUserGroupsV2InputSchema.shape,
  async (_params: ListUserGroupsV2Input) => {
    const response = await sendToMakeWebhook({
      path: "/v2/userGroups",
      method: "GET"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 58: keap_get_user_group
// API: GET /v2/userGroups/{user_group_id}
// ---------------------------------------------------------------------------
server.tool(
  "keap_get_user_group",
  `Retrieve a user group in Keap (V2).

API Endpoint: GET /v2/userGroups/{user_group_id}

Args:
  - user_group_id (string, required): User group ID`,
  GetUserGroupV2InputSchema.shape,
  async (params: GetUserGroupV2Input) => {
    const response = await sendToMakeWebhook({
      path: `/v2/userGroups/${params.user_group_id}`,
      method: "GET"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 59: keap_list_webforms
// API: GET /v2/webforms
// ---------------------------------------------------------------------------
server.tool(
  "keap_list_webforms",
  `List webforms in Keap (V2).

API Endpoint: GET /v2/webforms

Args:
  - filter (string, optional): Filter string
  - page_token (string, optional): Page token
  - order_by (string, optional): Order by field and direction
  - page_size (integer, optional): Results per page`,
  ListWebformsV2InputSchema.shape,
  async (params: ListWebformsV2Input) => {
    const query_params: Record<string, string | number | boolean | undefined> = {
      filter: params.filter,
      page_token: params.page_token,
      order_by: params.order_by,
      page_size: params.page_size
    };

    const response = await sendToMakeWebhook({
      path: "/v2/webforms",
      method: "GET",
      query_params
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// ---------------------------------------------------------------------------
// TOOL 60: keap_get_webform_data
// API: GET /v2/webforms/{webform_id}:data
// ---------------------------------------------------------------------------
server.tool(
  "keap_get_webform_data",
  `Retrieve submitted data for a webform in Keap (V2).

API Endpoint: GET /v2/webforms/{webform_id}:data

Args:
  - webform_id (string, required): Webform ID`,
  GetWebformDataV2InputSchema.shape,
  async (params: GetWebformDataV2Input) => {
    const response = await sendToMakeWebhook({
      path: `/v2/webforms/${params.webform_id}:data`,
      method: "GET"
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

// =============================================================================
// Transport Handlers
// =============================================================================

async function runServer() {
  if (!MAKE_WEBHOOK_URL) {
    console.error("ERROR: MAKE_WEBHOOK_URL environment variable is required.");
    console.error("  export MAKE_WEBHOOK_URL=https://hook.make.com/your-webhook-id");
    process.exit(1);
  }

  const app = express();
  let transport: SSEServerTransport;

  app.get("/sse", async (req, res) => {
    console.log("New SSE connection established");
    transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    if (transport) {
      await transport.handlePostMessage(req, res);
    } else {
      res.status(400).send("No transport initialized");
    }
  });

  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`${SERVER_NAME} v${SERVER_VERSION} running on port ${PORT}`);
    console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
    console.log(`Webhook: ${MAKE_WEBHOOK_URL.substring(0, 40)}...`);
  });
}

// =============================================================================
// Main Entry Point
// =============================================================================

runServer().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
