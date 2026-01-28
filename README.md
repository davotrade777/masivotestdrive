# Masivo Test Drive

A Node.js proxy server and demo client for integrating with the Masivo loyalty platform API. This project provides a complete authentication flow, purchase event tracking, and rewards redemption system.

## Features

### 🔐 Authentication
- **TOTP-based authentication**: Request and verify one-time passwords
- **JWT token management**: Secure app-level tokens with configurable expiration
- **Protected endpoints**: All API routes require valid authentication

### 👤 Customer Management
- **Customer information retrieval**: Fetch customer details and points balance
- **JWT payload inspection**: View decoded token information

### 🛒 Purchase Events
- **PURCHASE event tracking**: Record customer purchases with full order details
- **Flexible order structure**: Support for products, shipping, and order-level data
- **Automatic points calculation**: Masivo calculates points based on order value and campaign rules
- **Payment method tracking**: Support for CREDIT, DEBIT, CASH, BANK_TRANSFER, and OTHER
- **Note**: Points earned from purchases may take up to 3 minutes to appear in the Masivo dashboard

### 🎁 Rewards Redemption
- **Redemption preview**: Validate and preview rewards redemptions before actual redemption
- **Standalone redemption**: Direct point redemption via dedicated endpoint
- **Purchase-integrated redemption**: Redeem rewards as part of purchase events
- **Balance tracking**: Monitor points balance before and after redemption
- **Note**: Points deducted from redemptions may take up to 3 minutes to appear in the Masivo dashboard

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file in the root directory:

```env
# Masivo API Configuration
MASIVO_X_API_KEY=your-masivo-api-key-uuid
MASIVO_BASE_URL=https://app.masivo.ai/api/storefront/v1
MASIVO_REDEEM_BASE_URL=https://app.masivo.ai
MASIVO_REDEEM_PATH=/customers/{customer_id}/redeem

# Server Configuration
PORT=3000
API_URL=http://localhost:3000

# JWT Configuration
JWT_SECRET=your-strong-secret-key-min-16-chars
JWT_EXPIRES_IN=2h

# Demo Configuration
CUSTOMER_ID=your-customer-id
BRAND_ID=0001
REWARD_ID=your-reward-id
```

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `MASIVO_X_API_KEY` | Masivo API key (UUID format) | ✅ Yes | - |
| `MASIVO_BASE_URL` | Masivo storefront API base URL | No | `https://app.masivo.ai/api/storefront/v1` |
| `MASIVO_REDEEM_BASE_URL` | Base URL for redemption endpoints | No | Uses `MASIVO_BASE_URL` |
| `MASIVO_REDEEM_PATH` | Custom redemption endpoint path | No | `/customers/{customer_id}/redeem` |
| `PORT` | Server port | No | `3000` |
| `JWT_SECRET` | Secret for signing JWT tokens | ✅ Yes | - |
| `JWT_EXPIRES_IN` | JWT token expiration time | No | `2h` |
| `CUSTOMER_ID` | Customer ID for demo script | ✅ Yes (for demo) | - |
| `BRAND_ID` | Brand ID for events | No | `0001` |
| `REWARD_ID` | Reward ID for redemption | No | - |

## Usage

### Start the Server

```bash
npm run dev
# or
node server.js
```

The server will start on `http://localhost:3000` (or the port specified in `.env`).

### Run the Demo

```bash
npm run demo
# or
node demo-login.mjs
```

The demo script demonstrates the complete flow:
1. **TOTP Request** - Request a one-time password
2. **TOTP Verify** - Verify the code and receive app JWT token
3. **Get User Info** - Retrieve JWT payload
4. **Get Customer** - Fetch customer details and points balance
5. **Purchase Event** - Record a PURCHASE event with order details
6. **Rewards Redemption** - Preview and redeem rewards

## API Endpoints

### Public Endpoints

#### `POST /auth/totp/request`
Request a TOTP code for customer authentication.

**Request:**
```json
{
  "customer_id": "1716573314",
  "metadata": {}
}
```

**Response:**
```json
{
  "data": {
    "code": "123456"
  }
}
```

#### `POST /auth/totp/verify`
Verify TOTP code and receive app JWT token.

**Request:**
```json
{
  "customer_id": "1716573314",
  "code": "123456"
}
```

**Response:**
```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": "2h",
  "masivo_verify": { ... }
}
```

### Protected Endpoints (Require JWT Bearer Token)

#### `GET /api/me`
Get decoded JWT payload information.

**Headers:**
```
Authorization: Bearer <app_token>
```

**Response:**
```json
{
  "ok": true,
  "user": {
    "customer_id": "1716573314",
    "iat": 1234567890,
    "exp": 1234575090
  }
}
```

#### `GET /api/me/customer`
Fetch customer details from Masivo API.

**Headers:**
```
Authorization: Bearer <app_token>
```

**Response:**
```json
{
  "data": {
    "id": "1716573314",
    "points": 1000,
    ...
  }
}
```

#### `POST /api/behavior/events`
Record customer behavior events (e.g., PURCHASE).

**Headers:**
```
Authorization: Bearer <app_token>
```

**Request:**
```json
{
  "customer_id": "1716573314",
  "event_type": "PURCHASE",
  "brand_id": "0001",
  "order": {
    "purchase_id": "order-123",
    "value": 1000,
    "products": [
      {
        "sku": "product-1",
        "quantity": 2,
        "amount": 10,
        "value": 10
      }
    ],
    "payment_method": "OTHER"
  }
}
```

**Note:** Points are automatically calculated by Masivo based on order value and campaign rules.

#### `PUT /api/rewards/redeem/preview`
Preview and validate rewards redemptions before actual redemption.

**Headers:**
```
Authorization: Bearer <app_token>
```

**Request:**
```json
{
  "order": {
    "products": [
      {
        "sku": "product-1",
        "amount": 10,
        "value": 10,
        "redeem": [
          {
            "id": "reward-id",
            "amount": 6
          }
        ]
      }
    ],
    "value": 10
  }
}
```

**Response:**
```json
{
  "order": {
    "products": [
      {
        "sku": "product-1",
        "amount": 10,
        "value": 10,
        "redeem": [...],
        "redemptions_result": {
          "redeemed": [...],
          "value": 4,
          "discount_value": 6,
          "discount_percent": 0.6,
          "action": "UPDATE"
        }
      }
    ]
  }
}
```

#### `POST /api/rewards/redeem`
Redeem rewards (standalone redemption).

**Headers:**
```
Authorization: Bearer <app_token>
```

**Request:**
```json
{
  "customer_id": "1716573314",
  "reward_id": "67cd85fc-bbf7-4f58-a4e2-7ca6fc3e0438",
  "amount": 100
}
```

**Response:**
```json
{
  "success": true,
  ...
}
```

#### `GET /health`
Health check endpoint.

**Response:**
```json
{
  "ok": true
}
```

## Purchase Event Structure

### Required Fields
- `customer_id` (string): Customer identifier
- `event_type` (string): Event type (e.g., "PURCHASE")
- `brand_id` (string): Brand identifier
- `order` (object): Order details

### Order Object
```json
{
  "purchase_id": "unique-order-id",
  "value": 1000,
  "products": [
    {
      "sku": "product-sku",
      "quantity": 1,
      "amount": 10,
      "value": 10
    }
  ],
  "payment_method": "CREDIT" | "DEBIT" | "CASH" | "BANK_TRANSFER" | "OTHER"
}
```

### Redemption in Purchase Events

To redeem rewards as part of a purchase, include a `redeem` array in products:

```json
{
  "order": {
    "products": [
      {
        "sku": "product-1",
        "quantity": 1,
        "amount": 10,
        "value": 10,
        "redeem": [
          {
            "id": "reward-id",
            "amount": 6
          }
        ]
      }
    ],
    "value": 10,
    "payment_method": "OTHER"
  }
}
```

**Note:** Use `id` (not `reward_id`) when redeeming in purchase events.

## Architecture

### Server (`server.js`)
- Express.js server that proxies requests to Masivo API
- Handles Masivo API authentication (x-api-key → Bearer token)
- Issues JWT tokens for app-level authentication
- Validates and transforms request payloads

### Demo Client (`demo-login.mjs`)
- Demonstrates complete authentication and API usage flow
- Shows TOTP request/verify process
- Tests all protected endpoints
- Includes balance tracking for redemption verification

## Error Handling

All endpoints return appropriate HTTP status codes:
- `200`: Success
- `400`: Bad Request (missing/invalid parameters)
- `401`: Unauthorized (missing/invalid token)
- `404`: Not Found
- `422`: Unprocessable Entity (validation errors)
- `500`: Internal Server Error

Error responses include:
```json
{
  "error": "Error message",
  "details": { ... }
}
```

## Development

### Debug Logging

In non-production environments (`NODE_ENV !== "production"`), the server logs:
- Outgoing payloads to Masivo API
- Full URLs being called
- Request/response details

### Masivo Token Caching

The server caches Masivo access tokens for 30 seconds before expiration to reduce API calls.

## Important Notes

### Points Movement Delay

**⚠️ Points movements (adding or subtracting) may take up to 3 minutes to appear in the Masivo dashboard.**

This applies to:
- Points earned from purchase events
- Points deducted from reward redemptions
- Any other points transactions

The API calls will return successfully, but the balance updates in the Masivo dashboard may be delayed. When checking customer balance via the API or dashboard, allow up to 3 minutes for the changes to be reflected.

## License

[Add your license here]

## Contributing

[Add contribution guidelines here]
