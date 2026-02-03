/**
 * Keap MCP Server - Main Entry Point
 * 
 * An MCP server for Keap CRM using a proxy architecture.
 * All API calls are delegated to a Make.com webhook that handles authentication.
 * 
 * TOOLS IMPLEMENTED (V1 API):
 *   1. keap_list_contacts   - GET /v1/contacts
 *   2. keap_get_contact     - GET /v1/contacts/{id}
 *   3. keap_create_contact  - POST /v1/contacts
 *   4. keap_list_orders     - GET /v1/orders
 *   5. keap_get_order       - GET /v1/orders/{orderId}
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
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
// Transport Handlers
// =============================================================================

async function runStdio(): Promise<void> {
  if (!MAKE_WEBHOOK_URL) {
    console.error("ERROR: MAKE_WEBHOOK_URL environment variable is required.");
    console.error("  export MAKE_WEBHOOK_URL=https://hook.make.com/your-webhook-id");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error(`${SERVER_NAME} v${SERVER_VERSION} started (stdio)`);
  console.error(`Webhook: ${MAKE_WEBHOOK_URL.substring(0, 40)}...`);
  console.error(`Tools: keap_list_contacts, keap_get_contact, keap_create_contact, keap_list_orders, keap_get_order`);
}

// =============================================================================
// Main Entry Point
// =============================================================================

runStdio().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
