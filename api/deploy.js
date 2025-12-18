const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Konfigurasi
const MAX_QUOTA = 50; // Max 50 deploy per hari
const COOLDOWN_SECONDS = 300; // 5 menit cooldown
let quotaUsed = 0;
let lastDeployTime = 0;

// Simpan quota ke file (untuk persistensi)
const QUOTA_FILE = 'quota.json';

function loadQuota() {
    try {
        if (fs.existsSync(QUOTA_FILE)) {
            const data = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
            quotaUsed = data.quotaUsed || 0;
            lastDeployTime = data.lastDeployTime || 0;
        }
    } catch (error) {
        console.error('Error loading quota:', error);
    }
}

function saveQuota() {
    try {
        const data = {
            quotaUsed,
            lastDeployTime
        };
        fs.writeFileSync(QUOTA_FILE, JSON.stringify(data));
    } catch (error) {
        console.error('Error saving quota:', error);
    }
}

// Load quota saat startup
loadQuota();

// Reset quota setiap hari
function resetQuotaIfNeeded() {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    
    if (now - lastDeployTime > oneDay) {
        quotaUsed = 0;
        saveQuota();
    }
}

// Deploy endpoint
app.post('/api/deploy', async (req, res) => {
    resetQuotaIfNeeded();
    
    const { name, fileData, fileName } = req.body;
    
    // Check quota
    if (quotaUsed >= MAX_QUOTA) {
        return res.status(429).json({
            error: 'Quota harian habis',
            remainingQuota: 0,
            cooldown: true
        });
    }
    
    // Check cooldown
    const now = Math.floor(Date.now() / 1000);
    const timeSinceLastDeploy = now - lastDeployTime;
    
    if (timeSinceLastDeploy < COOLDOWN_SECONDS && lastDeployTime > 0) {
        const remainingSeconds = COOLDOWN_SECONDS - timeSinceLastDeploy;
        return res.status(429).json({
            error: `Tunggu ${remainingSeconds} detik sebelum deploy lagi`,
            remainingQuota: MAX_QUOTA - quotaUsed,
            cooldown: true,
            remainingSeconds
        });
    }
    
    // Validate inputs
    if (!name || name === 'quota-check') {
        return res.json({
            remainingQuota: MAX_QUOTA - quotaUsed,
            cooldown: timeSinceLastDeploy < COOLDOWN_SECONDS,
            remainingSeconds: timeSinceLastDeploy < COOLDOWN_SECONDS ? COOLDOWN_SECONDS - timeSinceLastDeploy : 0
        });
    }
    
    if (!fileData || !fileName) {
        return res.status(400).json({ error: 'File data diperlukan' });
    }
    
    try {
        // Decode base64 file
        const fileBuffer = Buffer.from(fileData, 'base64');
        
        // Create temp directory
        const tempDir = path.join(__dirname, 'temp', name);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // Save file
        const filePath = path.join(tempDir, fileName);
        fs.writeFileSync(filePath, fileBuffer);
        
        // Handle ZIP files
        if (fileName.toLowerCase().endsWith('.zip')) {
            const zip = new AdmZip(filePath);
            zip.extractAllTo(tempDir, true);
            fs.unlinkSync(filePath); // Remove the zip file
        }
        
        // Create vercel.json for configuration
        const vercelConfig = {
            name: name,
            version: 2,
            builds: [
                {
                    src: "*.html",
                    use: "@vercel/static"
                }
            ],
            routes: [
                {
                    src: "/(.*)",
                    dest: "/$1"
                }
            ]
        };
        
        fs.writeFileSync(
            path.join(tempDir, 'vercel.json'),
            JSON.stringify(vercelConfig, null, 2)
        );
        
        // Create index.html if it doesn't exist
        const indexPath = path.join(tempDir, 'index.html');
        if (!fs.existsSync(indexPath)) {
            // Find first HTML file
            const files = fs.readdirSync(tempDir);
            const htmlFile = files.find(f => f.toLowerCase().endsWith('.html'));
            
            if (htmlFile) {
                // Rename the HTML file to index.html
                fs.renameSync(
                    path.join(tempDir, htmlFile),
                    indexPath
                );
            } else {
                // Create a basic index.html
                fs.writeFileSync(indexPath, `
<!DOCTYPE html>
<html>
<head>
    <title>${name}</title>
    <style>
        body { 
            font-family: Arial, sans-serif; 
            margin: 40px; 
            background: #f0f0f0;
        }
        .container { 
            max-width: 800px; 
            margin: 0 auto; 
            background: white; 
            padding: 20px; 
            border-radius: 10px;
        }
        h1 { color: #333; }
    </style>
</head>
<body>
    <div class="container">
        <h1>${name}</h1>
        <p>Website ini di-deploy menggunakan Vercel Deployer</p>
    </div>
</body>
</html>
                `);
            }
        }
        
        // Simulate Vercel deployment (In production, use actual Vercel API)
        // For now, we'll simulate a successful deployment
        const deploymentUrl = `https://${name}.vercel.app`;
        
        // Update quota and last deploy time
        quotaUsed++;
        lastDeployTime = Math.floor(Date.now() / 1000);
        saveQuota();
        
        // Clean up temp files
        setTimeout(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }, 5000);
        
        // Return success response
        res.json({
            success: true,
            url: deploymentUrl,
            remainingQuota: MAX_QUOTA - quotaUsed,
            message: 'Deploy berhasil!'
        });
        
    } catch (error) {
        console.error('Deployment error:', error);
        res.status(500).json({
            error: `Deploy gagal: ${error.message}`,
            remainingQuota: MAX_QUOTA - quotaUsed
        });
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve index.html for all other routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
