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

/**
 * POST /v1/contacts - Create Contact
 */
const CreateContactInputSchema = z.object({
  given_name: z.string()
    .optional()
    .describe("First name"),
  
  family_name: z.string()
    .optional()
    .describe("Last name"),
  
  email: z.string()
    .email()
    .optional()
    .describe("Primary email address (will be added as EMAIL1)"),
  
  phone: z.string()
    .optional()
    .describe("Primary phone number (will be added as PHONE1)"),
  
  job_title: z.string()
    .optional()
    .describe("Job title"),
  
  company_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Company ID to link contact to"),
  
  owner_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("User ID of the contact owner"),
  
  lead_source_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Lead source ID"),
  
  opt_in_reason: z.string()
    .optional()
    .describe("Reason for opting in to email marketing"),
  
  website: z.string()
    .optional()
    .describe("Website URL"),
  
  time_zone: z.string()
    .optional()
    .describe("Time zone (e.g., America/New_York)"),
  
  source_type: z.enum([
    "APPOINTMENT", "FORMAPIHOSTED", "FORMAPIINTERNAL", "WEBFORM", 
    "INTERNALFORM", "LANDINGPAGE", "IMPORT", "MANUAL", "API", "OTHER", "UNKNOWN"
  ])
    .optional()
    .describe("How the contact was created")
}).strict();

type CreateContactInput = z.infer<typeof CreateContactInputSchema>;

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
// TOOL 3: keap_create_contact
// API: POST /v1/contacts
// ---------------------------------------------------------------------------
server.tool(
  "keap_create_contact",
  `Create a new contact in Keap CRM.

API Endpoint: POST /v1/contacts

Args:
  - given_name (string, optional): First name
  - family_name (string, optional): Last name
  - email (string, optional): Primary email address
  - phone (string, optional): Primary phone number
  - job_title (string, optional): Job title
  - company_id (integer, optional): Link to existing company
  - owner_id (integer, optional): Assigned user ID
  - lead_source_id (integer, optional): Lead source ID
  - opt_in_reason (string, optional): Email opt-in reason
  - website (string, optional): Website URL
  - time_zone (string, optional): Time zone
  - source_type (enum, optional): How contact was created

Returns:
  Created contact object with assigned ID.

Examples:
  - Basic: { "email": "john@example.com", "given_name": "John", "family_name": "Doe" }
  - With company: { "email": "jane@acme.com", "given_name": "Jane", "company_id": 456 }`,
  CreateContactInputSchema.shape,
  async (params: CreateContactInput) => {
    const body: Record<string, unknown> = {};

    // Simple string fields
    if (params.given_name) body.given_name = params.given_name;
    if (params.family_name) body.family_name = params.family_name;
    if (params.job_title) body.job_title = params.job_title;
    if (params.website) body.website = params.website;
    if (params.time_zone) body.time_zone = params.time_zone;
    if (params.opt_in_reason) body.opt_in_reason = params.opt_in_reason;
    if (params.source_type) body.source_type = params.source_type;

    // Integer fields
    if (params.owner_id) body.owner_id = params.owner_id;
    if (params.lead_source_id) body.lead_source_id = params.lead_source_id;

    // Email - convert to Keap API structure
    if (params.email) {
      body.email_addresses = [{
        email: params.email,
        field: "EMAIL1"
      }];
    }

    // Phone - convert to Keap API structure
    if (params.phone) {
      body.phone_numbers = [{
        number: params.phone,
        field: "PHONE1"
      }];
    }

    // Company - convert to Keap API structure
    if (params.company_id) {
      body.company = { id: params.company_id };
    }

    const response = await sendToMakeWebhook({
      path: "/v1/contacts",
      method: "POST",
      body
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

/**
 * POST /v1/notes - Create Note
 * Verified parameters from Keap V1 OpenAPI documentation
 */
const CreateNoteInputSchema = z.object({
  contact_id: z.number()
    .int()
    .positive()
    .describe("Contact ID to attach the note to (required)"),
  
  title: z.string()
    .optional()
    .describe("Note title (either title or body is required)"),
  
  body: z.string()
    .optional()
    .describe("Note body content (either title or body is required)"),
  
  type: z.enum(["Appointment", "Call", "Email", "Fax", "Letter", "Other"])
    .optional()
    .describe("Note type category"),
  
  user_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("User ID to assign the note to")
}).strict();

type CreateNoteInput = z.infer<typeof CreateNoteInputSchema>;

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
// TOOL 9: keap_create_note
// API: POST /v1/notes
// ---------------------------------------------------------------------------
server.tool(
  "keap_create_note",
  `Create a new note on a contact in Keap CRM.

API Endpoint: POST /v1/notes

Args:
  - contact_id (integer, required): Contact ID to attach the note to
  - title (string, optional): Note title
  - body (string, optional): Note body content
  - type (enum, optional): Note type - 'Appointment', 'Call', 'Email', etc.
  - user_id (integer, optional): User ID to assign the note to`,
  CreateNoteInputSchema.shape,
  async (params: CreateNoteInput) => {
    const body: Record<string, unknown> = {
      contact_id: params.contact_id
    };

    if (params.title) body.title = params.title;
    if (params.body) body.body = params.body;
    if (params.type) body.type = params.type;
    if (params.user_id) body.user_id = params.user_id;

    const response = await sendToMakeWebhook({
      path: "/v1/notes",
      method: "POST",
      body
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
 * POST /v1/tasks - Create Task
 * Verified from Keap V1 OpenAPI documentation
 */
const CreateTaskInputSchema = z.object({
  title: z.string()
    .describe("Task title (required)"),

  due_date: z.string()
    .describe("Task due date in ISO 8601 format, e.g. 2025-03-15T10:00:00.000Z (required)"),

  contact_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("Contact ID to associate the task with"),

  description: z.string()
    .optional()
    .describe("Task description"),

  user_id: z.number()
    .int()
    .positive()
    .optional()
    .describe("User ID to assign the task to"),

  completed: z.boolean()
    .optional()
    .describe("Whether the task is completed"),

  priority: z.number()
    .int()
    .optional()
    .describe("Task priority (integer)"),

  type: z.string()
    .optional()
    .describe("Task type"),

  remind_time: z.number()
    .int()
    .optional()
    .describe("Minutes before due_date to show reminder. Accepted values: 5, 10, 15, 30, 60..."),

  url: z.string()
    .optional()
    .describe("URL associated with the task")
}).strict();

type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

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

/**
 * POST /v1/contacts/{contactId}/tags - Apply Tags to Contact
 * Verified from Keap V1 OpenAPI documentation
 */
const ApplyTagInputSchema = z.object({
  contact_id: z.number()
    .int()
    .positive()
    .describe("Contact ID to apply tags to (path parameter)"),

  tag_ids: z.array(z.number().int().positive())
    .min(1)
    .describe("Array of Tag IDs to apply to the contact")
}).strict();

type ApplyTagInput = z.infer<typeof ApplyTagInputSchema>;

// ---------------------------------------------------------------------------
// TOOL 11: keap_create_task
// API: POST /v1/tasks
// ---------------------------------------------------------------------------
server.tool(
  "keap_create_task",
  `Create a new task in Keap CRM.

API Endpoint: POST /v1/tasks

Args:
  - title (string, required): Task title
  - due_date (string, required): Due date in ISO 8601 format
  - contact_id (integer, optional): Contact ID to associate with
  - description (string, optional): Task description
  - user_id (integer, optional): User ID to assign task to
  - completed (boolean, optional): Whether the task is completed
  - priority (integer, optional): Task priority
  - type (string, optional): Task type`,
  CreateTaskInputSchema.shape,
  async (params: CreateTaskInput) => {
    const body: Record<string, unknown> = {
      title: params.title,
      due_date: params.due_date
    };

    // Keap requires contact to be a nested object { id: 123 }
    if (params.contact_id) {
      body.contact = { id: params.contact_id };
    }

    if (params.description) body.description = params.description;
    if (params.user_id) body.user_id = params.user_id;
    if (params.completed !== undefined) body.completed = params.completed;
    if (params.priority !== undefined) body.priority = params.priority;
    if (params.type) body.type = params.type;
    if (params.remind_time !== undefined) body.remind_time = params.remind_time;
    if (params.url) body.url = params.url;

    const response = await sendToMakeWebhook({
      path: "/v1/tasks",
      method: "POST",
      body
    });

    const result = formatToolResponse(response);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: !result.success
    };
  }
);

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

// ---------------------------------------------------------------------------
// TOOL 15: keap_apply_tag
// API: POST /v1/contacts/{contactId}/tags
// ---------------------------------------------------------------------------
server.tool(
  "keap_apply_tag",
  `Apply one or more tags to a contact in Keap CRM.

API Endpoint: POST /v1/contacts/{contactId}/tags

Args:
  - contact_id (integer, required): Contact ID to apply tags to
  - tag_ids (array of integers, required): Tag IDs to apply`,
  ApplyTagInputSchema.shape,
  async (params: ApplyTagInput) => {
    const response = await sendToMakeWebhook({
      path: `/v1/contacts/${params.contact_id}/tags`,
      method: "POST",
      body: {
        tagIds: params.tag_ids // API expects camelCase 'tagIds'
      }
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
