# LaTeX Proxy Server

This is a simple Express.js proxy server that handles LaTeX compilation requests to avoid CORS issues.

## Why This Server?

The LaTeX.Online API doesn't support CORS (Cross-Origin Resource Sharing), which prevents direct requests from the browser. This proxy server acts as an intermediary, receiving requests from the frontend and forwarding them to LaTeX.Online.

## Installation

```bash
cd server
npm install
```

## Running the Server

```bash
npm start
```

The server will start on `http://localhost:3001`

## API Endpoints

### POST /api/compile

Compiles LaTeX code and returns a PDF.

**Request Body:**
```json
{
  "latexCode": "\\documentclass{article}\\begin{document}Hello\\end{document}"
}
```

**Success Response:**
```json
{
  "success": true,
  "pdf": "base64-encoded-pdf-data"
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Error message",
  "errors": [
    {
      "line": 5,
      "message": "Missing \\end{document}",
      "type": "error"
    }
  ]
}
```

### GET /

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "message": "LaTeX proxy server is running"
}
```

## Environment Variables

None required. The server uses default configuration:
- Port: 3001
- CORS Origin: http://localhost:3000

## Dependencies

- **express**: Web server framework
- **cors**: CORS middleware
- **multer**: Multipart form data handling
- **axios**: HTTP client for LaTeX.Online requests
- **form-data**: FormData implementation for Node.js


## Development

The server is configured to accept requests only from `http://localhost:3000`. To allow other origins, modify the CORS configuration in `server.js`.
