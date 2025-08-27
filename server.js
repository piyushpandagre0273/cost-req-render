require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

// --- Middleware ---
app.use(express.json()); // For parsing application/json
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Cloudinary Configuration ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_URL.split('@')[1],
    api_key: process.env.CLOUDINARY_URL.split('//')[1].split(':')[0],
    api_secret: process.env.CLOUDINARY_URL.split(':')[2].split('@')[0]
});

// --- Multer for file uploads ---
const storage = multer.memoryStorage(); // Store files in memory
const upload = multer({ storage: storage });

// --- PostgreSQL Configuration ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for Render's PostgreSQL
    }
});

// --- Database Initialization ---
async function initializeDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS requirement_types (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) UNIQUE NOT NULL
            );

            CREATE TABLE IF NOT EXISTS requirements (
                id SERIAL PRIMARY KEY,
                customer VARCHAR(255) NOT NULL,
                contact VARCHAR(255),
                type VARCHAR(255) NOT NULL,
                details TEXT NOT NULL,
                follow_up TEXT,
                status VARCHAR(50) DEFAULT 'Pending',
                images TEXT[],
                videos TEXT[],
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS comments (
                id SERIAL PRIMARY KEY,
                requirement_id INTEGER REFERENCES requirements(id) ON DELETE CASCADE,
                text TEXT,
                images TEXT[],
                videos TEXT[],
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Database tables checked/created successfully.');
    } catch (err) {
        console.error('Error initializing database:', err);
    }
}

// Initialize database when server starts
initializeDb();

// --- Helper function for Cloudinary uploads ---
async function uploadMediaToCloudinary(files) {
    const uploadedImageUrls = [];
    const uploadedVideoUrls = [];

    for (const file of files) {
        const b64 = Buffer.from(file.buffer).toString('base64');
        let dataURI = 'data:' + file.mimetype + ';base64,' + b64;

        try {
            const resourceType = file.mimetype.startsWith('image') ? 'image' : 'video';
            const result = await cloudinary.uploader.upload(dataURI, {
                resource_type: resourceType,
                folder: 'customer_requirements'
            });
            if (resourceType === 'image') {
                uploadedImageUrls.push(result.secure_url);
            } else {
                uploadedVideoUrls.push(result.secure_url);
            }
        } catch (uploadError) {
            console.error('Cloudinary upload error:', uploadError);
            // Decide how to handle upload errors (e.g., throw, skip, log)
        }
    }
    return { images: uploadedImageUrls, videos: uploadedVideoUrls };
}

// --- API Routes ---

// Get all requirements
app.get('/api/requirements', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM requirements ORDER BY created_at DESC');
        const requirements = result.rows;

        // Fetch comments for each requirement
        for (let req of requirements) {
            const commentsResult = await pool.query('SELECT * FROM comments WHERE requirement_id = $1 ORDER BY created_at ASC', [req.id]);
            req.comments = commentsResult.rows;
        }
        res.json(requirements);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Add a new requirement
app.post('/api/requirements', upload.array('media'), async (req, res) => {
    const { customer, contact, type, details, followUp } = req.body;
    const files = req.files || [];

    if (!customer || !type || !details) {
        return res.status(400).json({ error: 'Customer, type, and details are required.' });
    }

    try {
        const { images, videos } = await uploadMediaToCloudinary(files);

        const result = await pool.query(
            'INSERT INTO requirements (customer, contact, type, details, follow_up, images, videos) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;',
            [customer, contact, type, details, followUp, images, videos]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Update requirement status
app.put('/api/requirements/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const result = await pool.query(
            'UPDATE requirements SET status = $1 WHERE id = $2 RETURNING *;',
            [status, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Requirement not found.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Update requirement details
app.put('/api/requirements/:id', async (req, res) => {
    const { id } = req.params;
    const { customer, contact, type, details } = req.body;

    if (!customer || !type || !details) {
        return res.status(400).json({ error: 'Customer, type, and details are required.' });
    }

    try {
        const result = await pool.query(
            'UPDATE requirements SET customer = $1, contact = $2, type = $3, details = $4 WHERE id = $5 RETURNING *;',
            [customer, contact, type, details, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Requirement not found.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete a requirement
app.delete('/api/requirements/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Optionally, delete media from Cloudinary here if needed
        // This would require fetching the requirement first to get image/video URLs

        const result = await pool.query('DELETE FROM requirements WHERE id = $1 RETETING *;', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Requirement not found.' });
        }
        res.status(204).send(); // No content to send back
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Add a comment to a requirement
app.post('/api/requirements/:id/comments', upload.array('media'), async (req, res) => {
    const { id } = req.params;
    const { text } = req.body;
    const files = req.files || [];

    if (!text && files.length === 0) {
        return res.status(400).json({ error: 'Comment text or media is required.' });
    }

    try {
        const { images, videos } = await uploadMediaToCloudinary(files);

        const result = await pool.query(
            'INSERT INTO comments (requirement_id, text, images, videos) VALUES ($1, $2, $3, $4) RETURNING *;',
            [id, text, images, videos]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get all requirement types
app.get('/api/types', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM requirement_types ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Add a new requirement type
app.post('/api/types', async (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Type name is required.' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO requirement_types (name) VALUES ($1) RETURNING *;',
            [name]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete a requirement type
app.delete('/api/types/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM requirement_types WHERE id = $1 RETURNING *;', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Type not found.' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Route for the home page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customerreq.html'));
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});