import express from 'express';
import cors from 'cors';
import multer from 'multer';
import axios from 'axios';
import FormData from 'form-data';
import tar from 'tar-stream';
import zlib from 'zlib';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false // Adjust based on your needs
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: {
        success: false,
        error: 'Too many requests from this IP, please try again later.'
    }
});
app.use(limiter);

// Stricter compilation rate limiting
const compileLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // limit each IP to 10 compilation requests per minute
    message: {
        success: false,
        error: 'Too many compilation requests, please wait before trying again.'
    }
});

// Configure multer with size limits
const storage = multer.memoryStorage();
const upload = multer({ 
    storage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB
        files: 1
    },
    fileFilter: (req, file, cb) => {
        // Allow only specific file types if needed
        cb(null, true);
    }
});

// Enable CORS for frontend
const allowedOrigins = process.env.NODE_ENV === 'production' 
    ? [process.env.FRONTEND_URL]
    : ['http://localhost:3000', 'https://latex-ai.nishantv.dev' ,process.env.FRONTEND_URL || ''];

app.use(cors({
    origin: allowedOrigins.filter(Boolean),
    credentials: true,
    optionsSuccessStatus: 200
}));

// Request size limits
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Request timeout middleware
app.use((req, res, next) => {
    req.setTimeout(120000); // 2 minutes
    res.setTimeout(120000);
    next();
});

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'LaTeX proxy server is running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Proxy endpoint for LaTeX compilation
app.post('/api/compile', compileLimiter, upload.single('file'), async (req, res) => {
        try {
                const latexCode = req.body.latexCode;
                const projectFiles = req.body.projectFiles || [];

                // Input validation
                if (!latexCode || typeof latexCode !== 'string') {
                        return res.status(400).json({ 
                                success: false, 
                                error: 'Valid LaTeX code is required' 
                        });
                }

                if (latexCode.length > 1024 * 1024) { // 1MB limit for LaTeX code
                        return res.status(400).json({
                                success: false,
                                error: 'LaTeX code is too large'
                        });
                }

                if (!Array.isArray(projectFiles) || projectFiles.length > 50) {
                        return res.status(400).json({
                                success: false,
                                error: 'Invalid project files'
                        });
                }

                // Create a tar archive with all project files
                const pack = tar.pack();
                
                // Add the main.tex file to the tar archive
                pack.entry({ name: 'main.tex' }, latexCode);

                // Add additional project files with validation
                for (const file of projectFiles) {
                        if (!file.name || !file.content || !file.type) {
                                continue; // Skip invalid files
                        }                                                
                        
                        if (file.type === 'image') {
                                try {
                                        const imageBuffer = Buffer.from(file.content, 'base64');
                                        if (imageBuffer.length > 10 * 1024 * 1024) { // 10MB limit per image
                                                continue;
                                        }
                                        pack.entry({ name: file.name }, imageBuffer);
                                } catch (e) {
                                        continue; // Skip invalid base64
                                }
                        } else {
                                if (file.content.length > 1024 * 1024) { // 1MB limit per text file
                                        continue;
                                }
                                pack.entry({ name: file.name }, file.content);
                        }
                }

                pack.finalize();

                // Compress the tar archive
                const chunks = [];
                const gzipStream = pack.pipe(zlib.createGzip());
                
                for await (const chunk of gzipStream) {
                        chunks.push(chunk);
                }
                
                const tarballBuffer = Buffer.concat(chunks);

                // Check total size limit
                if (tarballBuffer.length > 50 * 1024 * 1024) { // 50MB total limit
                        return res.status(400).json({
                                success: false,
                                error: 'Project size exceeds limit'
                        });
                }

                // Create FormData for file upload to LaTeX.Online    
                const formData = new FormData();
                formData.append('file', tarballBuffer, {
                        filename: 'project.tar.gz',
                        contentType: 'application/gzip'
                });

                // Make request to LaTeX.Online using POST with tarball upload
                const response = await axios.post('https://latexonline.cc/data', formData, {
                        params: {
                                command: 'pdflatex',
                                target: 'main.tex'
                        },
                        headers: {
                                ...formData.getHeaders(),
                                'User-Agent': 'LaTeX-Editor-Server/1.0'
                        },
                        responseType: 'arraybuffer',
                        timeout: process.env.NODE_ENV === 'production' ? 90000 : 60000,
                        maxContentLength: 100 * 1024 * 1024, // 100MB
                        maxBodyLength: 100 * 1024 * 1024
                });

                // Convert PDF to base64
                const pdfBase64 = Buffer.from(response.data).toString('base64');

                res.json({
                        success: true,
                        pdf: pdfBase64
                });

        } catch (error) {
                console.error('LaTeX compilation error:', {
                        message: error.message,
                        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
                        timestamp: new Date().toISOString()
                });
                
                // Parse error response if available
                let errorMessage = 'Compilation failed';
                let errors = [];

                if (error.response?.data) {
                        try {
                                const errorText = Buffer.from(error.response.data).toString('utf-8');
                                errorMessage = errorText.substring(0, 1000); // Limit error message size
                                errors = parseLatexErrors(errorText);
                        } catch (e) {
                                console.error('Error parsing response:', e.message);
                        }
                } else if (error.code === 'ECONNABORTED') {
                        errorMessage = 'Compilation timeout';
                } else if (error.code === 'ENOTFOUND') {
                        errorMessage = 'Service temporarily unavailable';
                }

                res.status(error.response?.status || 500).json({
                        success: false,
                        error: errorMessage,
                        errors: errors.slice(0, 20) // Limit number of errors
                });
        }
});

// Error handling middleware
app.use((err, req, res, next) => {
        console.error('Unhandled error:', {
                message: err.message,
                stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
                timestamp: new Date().toISOString()
        });
        
        res.status(500).json({
                success: false,
                error: 'Internal server error'
        });
});

// 404 handler
app.use('*', (req, res) => {
        res.status(404).json({
                success: false,
                error: 'Endpoint not found'
        });
});

// Helper function to parse LaTeX errors
function parseLatexErrors(log) {
        const errors = [];
        const lines = log.split('\n');

        for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                // Match common LaTeX error patterns
                const errorMatch = line.match(/^! (.+)$/);
                const lineMatch = line.match(/l\.(\d+)/);

                if (errorMatch) {
                        const lineNumber = lineMatch ? parseInt(lineMatch[1]) : 0;
                        errors.push({
                                line: Math.max(0, lineNumber),
                                message: errorMatch[1].substring(0, 200), // Limit message length
                                type: 'error'
                        });
                }

                // Match warnings
                const warningMatch = line.match(/^LaTeX Warning: (.+)$/);
                if (warningMatch) {
                        errors.push({
                                line: 0,
                                message: warningMatch[1].substring(0, 200),
                                type: 'warning'
                        });
                }
        }

        return errors;
}

// Graceful shutdown
process.on('SIGTERM', () => {
        console.log('SIGTERM received, shutting down gracefully');
        process.exit(0);
});

process.on('SIGINT', () => {
        console.log('SIGINT received, shutting down gracefully');
        process.exit(0);
});

const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 LaTeX Proxy Server running on port ${PORT}`);
        console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`✅ Ready to compile LaTeX documents`);
});

// Handle server errors
server.on('error', (err) => {
        console.error('Server error:', err);
        process.exit(1);
});

export default app;
