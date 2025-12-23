const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const axios = require('axios'); // Added axios for server-side requests
const XLSX = require('xlsx');

const app = express();
const PORT = 3000;
const EXTERNAL_API_URL = 'https://your-external-api.com/receive'; // CHANGE THIS
const DATA_DIR = path.join(__dirname, 'data');
const IMG_DIR = path.join(__dirname, 'images');
const MASTER_URL = 'https://www.netmeds.com/collection/all-medicines';
const JOBS_FILE = path.join(__dirname, 'jobs.json');

app.use(bodyParser.json({ limit: '50mb' }));
app.use('/images', express.static(IMG_DIR));

let jobs = [];
let isScrapingMaster = false;
let isStoppingImages = false;

// Worker Progress Tracking
let workerProgress = {}; // { workerId: { categoryName, categoryUrl, status, currentProduct, totalProducts, progress, lastUpdate } }

// Helper to sanitize names for folders/files
const sanitize = (name) => (name || '').replace(/[^a-z0-9]/gi, '_').toLowerCase();

// Helper to download an image from a URL
async function downloadImage(url, folderPath, fileName) {
    try {
        await fs.mkdir(folderPath, { recursive: true });
        const filePath = path.join(folderPath, fileName);

        // --- 🔁 RESUME LOGIC: Skip if exists ---
        try {
            await fs.access(filePath);
            // console.log(`⏩ Skipping existing image: ${fileName}`);
            return true;
        } catch (e) {
            // File doesn't exist, proceed to download
        }

        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout: 30000
        });

        const writer = require('fs').createWriteStream(filePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (err) {
        console.error(`  ❌ Failed to download image: ${url} -> ${err.message}`);
        return false;
    }
}

async function saveJobs() {
    await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

async function loadJobs() {
    try {
        const data = await fs.readFile(JOBS_FILE, 'utf8');
        jobs = JSON.parse(data);
        console.log(`Loaded ${jobs.length} jobs from file.`);
    } catch (err) {
        jobs = [];
    }
}

async function scrapeMasterCategories() {
    if (isScrapingMaster) return;
    isScrapingMaster = true;
    console.log('🔍 Fetching master category list...');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    try {
        await page.goto(MASTER_URL, { waitUntil: 'networkidle2', timeout: 90000 });
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('div')).filter(el => /\+\s*\d+\s*more/i.test(el.innerText));
            buttons.forEach(btn => btn.click());
        });
        await new Promise(r => setTimeout(r, 5000));
        const categories = await page.$$eval('a[href*="categorynamelevel2="]', links =>
            links.map(l => ({ name: l.innerText.trim(), url: l.href }))
        );

        categories.forEach(cat => {
            if (!jobs.find(j => j.url === cat.url)) {
                jobs.push({
                    ...cat,
                    status: 'pending',
                    workerId: null,
                    updatedAt: null,
                    retryCount: 0
                });
            }
        });
        await saveJobs();
        console.log(`📦 Discovered ${categories.length} total categories.`);
    } catch (err) {
        console.error('❌ Master Page Error:', err.message);
    } finally {
        await browser.close();
        isScrapingMaster = false;
    }
}

// --- 📂 Data Viewer ---
app.get('/view-data', async (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).send('Category name is required');
    try {
        const safeName = sanitize(name);
        const filePath = path.join(DATA_DIR, `${safeName}.json`);

        // Use fs.readFile directly and catch error if file doesn't exist
        let data;
        try {
            const content = await fs.readFile(filePath, 'utf8');
            data = JSON.parse(content);
        } catch (e) {
            return res.status(404).send(`<h1>File Not Found</h1><p>No data found for ${name}</p>`);
        }

        let rowsHtml = data.map(m => `
            <tr>
                <td><img src="${m.images && m.images[0] ? m.images[0] : 'https://via.placeholder.com/50'}" width="50" style="border-radius:4px;"></td>
                <td style="font-weight:600;">${m.name}<br><small style="color:var(--text-dim);font-weight:400;">${m.brand || 'No Brand'}</small></td>
                <td>${m.price?.bestPrice || m.price?.mrp || 'N/A'}</td>
                <td><span style="font-size: 0.8em; color: var(--text-dim);">${Array.isArray(m.category) ? m.category.join(' > ') : ''}</span></td>
                <td><a href="${m.url}" target="_blank" style="color: var(--accent); text-decoration: none;">Link 🔗</a></td>
            </tr>
        `).join('');

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>View Data: ${name}</title>
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
                <style>
                    :root { --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); --accent: #38bdf8; --text: #f8fafc; --text-dim: #94a3b8; }
                    body { font-family: 'Inter', sans-serif; background: var(--bg); padding: 40px; color: var(--text); }
                    .container { max-width: 1200px; margin: 0 auto; background: var(--card-bg); padding: 30px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); }
                    h1 { margin-top: 0; color: var(--text); border-bottom: 2px solid rgba(255,255,255,0.1); padding-bottom: 15px; }
                    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                    th { text-align: left; background: rgba(255,255,255,0.05); padding: 12px; font-weight: 600; border-bottom: 2px solid rgba(255,255,255,0.1); color: var(--text-dim); }
                    td { padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); vertical-align: middle; }
                    .back-btn { display: inline-block; margin-bottom: 20px; text-decoration: none; color: white; background: #475569; padding: 8px 16px; border-radius: 6px; font-size: 14px; }
                    .back-btn:hover { background: #334155; }
                </style>
            </head>
            <body>
                <div class="container">
                    <a href="http://localhost:3000/" class="back-btn">← Back to Dashboard</a>
                    <h1>📦 ${name} <small style="font-weight: normal; color: var(--text-dim); font-size: 0.6em;">(${data.length} items)</small></h1>
                    <table>
                        <thead>
                            <tr>
                                <th>Image</th>
                                <th>Product</th>
                                <th>Price</th>
                                <th>Breadcrumb</th>
                                <th>Url</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send(`Error reading data: ${err.message}`);
    }
});

// --- 📚 System Instructions ---
app.get('/instructions', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>System Guide: Netmeds Scraper</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
            <style>
                :root { --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); --accent: #38bdf8; --text: #f8fafc; --text-dim: #94a3b8; --success: #22c55e; }
                body { font-family: 'Inter', sans-serif; background: var(--bg); padding: 40px; color: var(--text); line-height: 1.6; }
                .container { max-width: 900px; margin: 0 auto; background: var(--card-bg); padding: 40px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); }
                h1 { color: var(--accent); margin-bottom: 30px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px; }
                h2 { color: var(--text); margin-top: 40px; border-left: 4px solid var(--accent); padding-left: 15px; }
                h3 { color: var(--text-dim); margin-top: 20px; }
                code { background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; font-family: monospace; color: #fbbf24; }
                pre { background: rgba(0,0,0,0.5); padding: 15px; border-radius: 8px; overflow-x: auto; border: 1px solid rgba(255,255,255,0.05); }
                .back-btn { display: inline-block; margin-bottom: 20px; text-decoration: none; color: white; background: #475569; padding: 8px 16px; border-radius: 6px; font-size: 14px; }
                .back-btn:hover { background: #334155; }
                ul, ol { margin-bottom: 20px; }
                li { margin-bottom: 10px; }
                hr { border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 40px 0; }
                .tip { background: rgba(34, 197, 94, 0.1); border-left: 4px solid var(--success); padding: 15px; border-radius: 4px; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <a href="http://localhost:3000/" class="back-btn">← Back to Dashboard</a>
                <h1>🏥 Netmeds Scraper: System Guide</h1>
                
                <p>Welcome to the Scraper Control Hub. This guide will help you set up and run the system like a pro.</p>

                <h2>🏗️ How the System Works</h2>
                <p>The system is split into two parts:</p>
                <ul>
                    <li><b>The Server (This Machine)</b>: Manages the list of 152 categories and coordinates the work.</li>
                    <li><b>Workers (Other PCs)</b>: These PCs connect to the server, ask for a category, scrape it, and send the data back.</li>
                </ul>

                <h2>🌐 Connecting other Worker PCs</h2>
                <ol>
                    <li>Copy <code>worker.js</code> and <code>package.json</code> to the new PC.</li>
                    <li>Open <code>worker.js</code> and change the <code>SERVER_URL</code> to match this server's IP.</li>
                    <li>Run <code>npm install</code> then <code>node worker.js</code>.</li>
                </ol>

                <div class="tip">
                    <b>💡 Pro-Tip</b>: Turn on a VPN on any worker PC to change its location and avoid blocks.
                </div>

                <h2>🔗 Features & Links</h2>
                <ul>
                    <li><b>Dashboard</b>: View real-time progress of all categories.</li>
                    <li><b>View Data</b>: Click "View" on any category to see scraped medicines.</li>
                    <li><b>Excel Export</b>: Download a master sheet of all discovered products.</li>
                    <li><b>Image Downloader</b>: Use the dashboard to start downloading all product photos.</li>
                </ul>

                <h2>🔄 Management</h2>
                <ul>
                    <li><b>Reset Stuck</b>: If a worker PC crashes, use this to put "Working" categories back to "Pending".</li>
                    <li><b>Reset All</b>: Use this only if you want to wipe everything and start a fresh scrape.</li>
                </ul>

                <hr>
                <p style="text-align: center; color: var(--text-dim);">Need help? Check the <code>SCRAPER_SYSTEM_GUIDE.md</code> file in the folder.</p>
            </div>
        </body>
        </html>
    `);
});

// --- 🏠 MAIN DASHBOARD ---
app.get('/', (req, res) => {
    const stats = {
        total: jobs.length,
        pending: jobs.filter(j => j.status === 'pending').length,
        in_progress: jobs.filter(j => j.status === 'in_progress').length,
        completed: jobs.filter(j => j.status === 'completed').length,
        failed: jobs.filter(j => j.status === 'failed').length
    };

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Somacy Scraper Dashboard</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
        <style>
            :root {
                --bg: #0f172a;
                --card-bg: rgba(30, 41, 59, 0.7);
                --accent: #38bdf8;
                --accent-glow: rgba(56, 189, 248, 0.3);
                --text: #f8fafc;
                --text-dim: #94a3b8;
                --success: #22c55e;
                --pending: #f59e0b;
                --failed: #ef4444;
                --working: #8b5cf6;
            }

            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
                font-family: 'Inter', sans-serif;
                background: var(--bg);
                color: var(--text);
                line-height: 1.6;
                background-image: radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%);
                min-height: 100vh;
                padding: 2rem;
            }
            .container { max-width: 1200px; margin: 0 auto; }
            header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 3rem;
                backdrop-filter: blur(10px);
                padding: 1.5rem;
                border-radius: 1rem;
                background: var(--card-bg);
                border: 1px solid rgba(255, 255, 255, 0.1);
            }
            .logo-area h1 { font-size: 1.5rem; font-weight: 700; color: var(--accent); }
            .logo-area p { font-size: 0.875rem; color: var(--text-dim); }
            .status-indicator {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                background: rgba(34, 197, 94, 0.1);
                padding: 0.5rem 1rem;
                border-radius: 2rem;
                color: var(--success);
                font-size: 0.875rem;
                font-weight: 600;
                border: 1px solid rgba(34, 197, 94, 0.2);
            }
            .pulse { width: 8px; height: 8px; background: var(--success); border-radius: 50%; box-shadow: 0 0 10px var(--success); animation: pulse 2s infinite; }
            @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.2); } 100% { opacity: 1; transform: scale(1); } }
            .stats-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 1.5rem;
                margin-bottom: 3rem; 
            }
            .stat-card {
                background: var(--card-bg);
                padding: 1.5rem;
                border-radius: 1rem;
                border: 1px solid rgba(255, 255, 255, 0.05);
                transition: transform 0.3s ease, box-shadow 0.3s ease;
            }
            .stat-card:hover { transform: translateY(-5px); box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
            .stat-card h3 { font-size: 0.875rem; color: var(--text-dim); margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; }
            .stat-card .value { font-size: 2.3rem; font-weight: 700; }
            .stat-card.total { border-left: 4px solid var(--accent); }
            .stat-card.pending { border-left: 4px solid var(--pending); }
            .stat-card.working { border-left: 4px solid var(--working); }
            .stat-card.completed { border-left: 4px solid var(--success); }
            .stat-card.failed { border-left: 4px solid var(--failed); }

            .action-panel {
                background: var(--card-bg);
                padding: 1.5rem;
                border-radius: 1rem;
                border: 1px solid rgba(255, 255, 255, 0.05);
                margin-bottom: 2rem;
            }
            .action-panel h2 { margin-bottom: 1rem; font-size: 1.1rem; }
            .btn-group { display: flex; flex-wrap: wrap; gap: 1rem; }
            .btn {
                padding: 0.75rem 1.5rem;
                border-radius: 0.5rem;
                text-decoration: none;
                font-weight: 600;
                font-size: 0.875rem;
                transition: all 0.3s ease;
                display: flex;
                align-items: center;
                gap: 0.5rem;
                cursor: pointer;
                border: none;
            }
            .btn-primary { background: var(--accent); color: #000; }
            .btn-primary:hover { background: #7dd3fc; transform: scale(1.02); }
            .btn-secondary { background: rgba(255,255,255,0.05); color: var(--text); border: 1px solid rgba(255,255,255,0.1); }
            .btn-secondary:hover { background: rgba(255,255,255,0.1); }

            .data-section {
                background: var(--card-bg);
                border-radius: 1rem;
                border: 1px solid rgba(255, 255, 255, 0.05);
                overflow: hidden;
            }
            .data-header { padding: 1.5rem; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between; align-items: center; }
            .search-box { background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.1); padding: 0.5rem 1rem; border-radius: 0.5rem; color: #fff; width: 300px; }
            table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
            th { text-align: left; padding: 1rem 1.5rem; background: rgba(255,255,255,0.02); color: var(--text-dim); font-weight: 600; }
            td { padding: 1rem 1.5rem; border-bottom: 1px solid rgba(255,255,255,0.05); }
            tr:hover { background: rgba(255,255,255,0.02); }
            .badge { padding: 0.25rem 0.75rem; border-radius: 1rem; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; }
            .badge-pending { background: rgba(245, 158, 11, 0.1); color: var(--pending); }
            .badge-working { background: rgba(139, 92, 246, 0.1); color: var(--working); }
            .badge-completed { background: rgba(34, 197, 94, 0.1); color: var(--success); }
            .badge-failed { background: rgba(239, 68, 68, 0.1); color: var(--failed); }
            .push-btn { color: var(--accent); text-decoration: none; font-weight: 600; border: 1px solid var(--accent); padding: 0.25rem 0.5rem; border-radius: 0.25rem; transition: all 0.2s; font-size: 0.75rem; }
            .push-btn:hover { background: var(--accent); color: #000; }
            .view-btn { color: var(--working); text-decoration: none; font-weight: 600; border: 1px solid var(--working); padding: 0.25rem 0.5rem; border-radius: 0.25rem; transition: all 0.2s; font-size: 0.75rem; }
            .view-btn:hover { background: var(--working); color: #fff; }
        </style>
    </head>
    <body>
        <div class="container">
            <header>
                <div class="logo-area">
                    <h1>SOMACY ORCHESTRATOR</h1>
                    <p>Distributed Scraping Control Hub</p>
                </div>
                <div class="status-indicator">
                    <div class="pulse"></div>
                    SERVER LIVE
                </div>
            </header>

            <div class="stats-grid">
                <div class="stat-card total"><h3>Total Categories</h3><div class="value">${stats.total}</div></div>
                <div class="stat-card pending"><h3>Pending</h3><div class="value">${stats.pending}</div></div>
                <div class="stat-card working"><h3>In Progress</h3><div class="value">${stats.in_progress}</div></div>
                <div class="stat-card completed"><h3>Completed</h3><div class="value">${stats.completed}</div></div>
                <div class="stat-card failed"><h3>Failed</h3><div class="value">${stats.failed}</div></div>
            </div>

            <div class="action-panel">
                <h2>Quick Actions</h2>
                <div class="btn-group">
                    <a href="http://localhost:3000/instructions" class="btn btn-primary" style="background:var(--working); color:#fff;">📚 System Guide</a>
                    <a href="http://localhost:3000/get-excel" class="btn btn-primary">📊 Download Excel</a>
                    <a href="http://localhost:3000/download-images" class="btn btn-primary">📸 Download Images</a>
                    <a href="http://localhost:3000/view-images" class="btn btn-primary" style="background:var(--accent); color:#000;">🖼️ View Gallery</a>
                    <a href="http://localhost:3000/start-worker" class="btn btn-secondary">🚀 Start Worker</a>
                    <a href="http://localhost:3000/reset-stuck" class="btn btn-secondary">🔄 Reset Stuck</a>
                    <a href="http://localhost:3000/retry-failed" class="btn btn-secondary">🔁 Retry Failed</a>
                    <a href="http://localhost:3000/validate-data" class="btn btn-secondary">🔍 Validate Data</a>
                    <a href="http://localhost:3000/scan-partial-data" class="btn btn-secondary">📂 Scan Partial Data</a>
                    <a href="http://localhost:3000/reset-all" class="btn btn-secondary">⚠️ Reset All</a>
                </div>
            </div>

            <div class="data-section">
                <div class="data-header">
                    <h2>Job Status List</h2>
                    <div style="display: flex; gap: 10px;">
                        <select class="search-box" style="width: 150px; cursor: pointer;" id="statusFilter">
                            <option value="all">All Statuses</option>
                            <option value="pending">Pending</option>
                            <option value="in_progress">In Progress</option>
                            <option value="completed">Completed</option>
                            <option value="failed">Failed</option>
                        </select>
                        <input type="text" class="search-box" placeholder="Search categories..." id="search">
                    </div>
                </div>
                <div style="max-height: 500px; overflow-y: auto;">
                    <table>
                        <thead>
                            <tr>
                                <th>Category Name</th>
                                <th>Status</th>
                                <th>Retries</th>
                                <th>Last Update</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody id="job-table">
                            ${jobs.map(j => `
                                <tr>
                                    <td><b>${j.name}</b></td>
                                    <td><span class="badge badge-${j.status.replace('_', '')}">${j.status.toUpperCase()}</span></td>
                                    <td>${j.retryCount || 0}/3</td>
                                    <td>${j.updatedAt ? new Date(j.updatedAt).toLocaleString() : '-'}</td>
                                    <td>
                                        <div class="action-btns">
                                            ${j.status === 'completed' ? `
                                                <a href="/view-data?name=${encodeURIComponent(j.name)}" class="view-btn">View</a>
                                                <a href="/push-category?name=${encodeURIComponent(j.name)}" class="push-btn">Push API</a>
                                            ` : '-'}
                                        </div>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <script>
            const searchInput = document.getElementById('search');
            const statusFilter = document.getElementById('statusFilter');
            const tableRows = document.querySelectorAll('#job-table tr');

            function filterTable() {
                const term = searchInput.value.toLowerCase();
                const status = statusFilter.value;

                tableRows.forEach(row => {
                    const nameMatch = row.cells[0].innerText.toLowerCase().includes(term);
                    const statusText = row.cells[1].innerText.toLowerCase().replace(' ', '_');
                    const statusMatch = (status === 'all' || statusText === status);
                    
                    row.style.display = (nameMatch && statusMatch) ? '' : 'none';
                });
            }

            searchInput.addEventListener('input', filterTable);
            statusFilter.addEventListener('change', filterTable);
        </script>
    </body>
    </html>`;
    res.send(html);
});

app.get('/status', (req, res) => {
    const stats = {
        total: jobs.length,
        pending: jobs.filter(j => j.status === 'pending').length,
        in_progress: jobs.filter(j => j.status === 'in_progress').length,
        completed: jobs.filter(j => j.status === 'completed').length,
        failed: jobs.filter(j => j.status === 'failed').length
    };
    res.json(stats);
});

app.get('/get-batch', async (req, res) => {
    const { workerId, size = 10 } = req.query;
    if (!workerId) return res.status(400).json({ error: 'workerId required' });

    const batch = jobs
        .filter(j => j.status === 'pending')
        .slice(0, parseInt(size));

    batch.forEach(job => {
        job.status = 'in_progress';
        job.workerId = workerId;
        job.updatedAt = new Date().toISOString();
    });

    if (batch.length > 0) await saveJobs();
    res.json(batch);
});

app.post('/report-success', async (req, res) => {
    const { categoryUrl, data } = req.body;
    const job = jobs.find(j => j.url === categoryUrl);
    if (job) {
        job.status = 'completed';
        job.updatedAt = new Date().toISOString();

        const safeName = job.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const fileName = path.join(DATA_DIR, `${safeName}.json`);
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(fileName, JSON.stringify(data, null, 2));

        await saveJobs();
        console.log(`✅ [${job.name}] Saved results.`);
    }
    res.json({ success: true });
});

app.post('/report-failure', async (req, res) => {
    const { categoryUrl, error } = req.body;
    const job = jobs.find(j => j.url === categoryUrl);
    if (job) {
        job.retryCount = (job.retryCount || 0) + 1;
        job.updatedAt = new Date().toISOString();
        job.error = error;

        if (job.retryCount < 3) {
            job.status = 'pending'; // Retry
            console.log(`⚠️ [${job.name}] Failed. Retry attempt ${job.retryCount}/3`);
        } else {
            job.status = 'failed'; // Mark as failed after 3 attempts
            console.log(`❌ [${job.name}] Permanently failed after 3 attempts.`);
        }
        await saveJobs();
    }
    res.json({ success: true });
});

// --- 📊 Worker Progress Tracking ---
app.post('/report-progress', (req, res) => {
    const { workerId, categoryName, categoryUrl, status, currentProduct, totalProducts, progress } = req.body;

    if (!workerId) return res.status(400).json({ error: 'workerId required' });

    workerProgress[workerId] = {
        categoryName: categoryName || 'Unknown',
        categoryUrl: categoryUrl || '',
        status: status || 'working',
        currentProduct: currentProduct || 0,
        totalProducts: totalProducts || 0,
        progress: progress || 0,
        lastUpdate: new Date().toISOString()
    };

    res.json({ success: true });
});

app.get('/worker-status', (req, res) => {
    // Clean up stale workers (no update in last 5 minutes)
    const now = new Date();
    const STALE_TIMEOUT = 5 * 60 * 1000;

    Object.keys(workerProgress).forEach(workerId => {
        const worker = workerProgress[workerId];
        if (worker.lastUpdate && (now - new Date(worker.lastUpdate)) > STALE_TIMEOUT) {
            delete workerProgress[workerId];
        }
    });

    res.json(workerProgress);
});

// --- 💾 Partial Data Handling for Resume/Recovery ---
app.post('/report-partial', async (req, res) => {
    const { categoryUrl, data, isComplete } = req.body;
    const job = jobs.find(j => j.url === categoryUrl);

    if (!job) return res.status(404).json({ error: 'Job not found' });

    try {
        const safeName = sanitize(job.name);
        const partialDir = path.join(DATA_DIR, 'partial');
        const partialFile = path.join(partialDir, `${safeName}_partial.json`);

        // Save partial data
        await fs.mkdir(partialDir, { recursive: true });
        await fs.writeFile(partialFile, JSON.stringify(data, null, 2));

        if (isComplete) {
            // Move to final location
            const finalFile = path.join(DATA_DIR, `${safeName}.json`);
            await fs.rename(partialFile, finalFile);
            job.status = 'completed';
            console.log(`✅ [${job.name}] Completed and saved ${data.length} products.`);
        } else {
            console.log(`💾 [${job.name}] Saved partial progress: ${data.length} products.`);
        }

        job.updatedAt = new Date().toISOString();
        await saveJobs();

        res.json({ success: true });
    } catch (err) {
        console.error(`❌ [${job.name}] Error saving partial data:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/get-partial-data', async (req, res) => {
    const { categoryUrl } = req.query;

    if (!categoryUrl) return res.status(400).json({ error: 'categoryUrl required' });

    const job = jobs.find(j => j.url === categoryUrl);
    if (!job) return res.json({ exists: false, data: [] });

    const safeName = sanitize(job.name);
    const partialFile = path.join(DATA_DIR, 'partial', `${safeName}_partial.json`);

    try {
        const content = await fs.readFile(partialFile, 'utf8');
        const data = JSON.parse(content);
        console.log(`📥 [${job.name}] Loaded partial data: ${data.length} products.`);
        res.json({ exists: true, data });
    } catch (err) {
        // No partial data exists
        res.json({ exists: false, data: [] });
    }
});

// --- 🔍 Validate and Reset Incomplete Data ---
app.get('/validate-data', async (req, res) => {
    try {
        console.log('🔍 Starting data validation...');

        const results = {
            checked: 0,
            incomplete: [],
            partialFound: [],
            reset: []
        };

        // Check all jobs marked as completed
        const completedJobs = jobs.filter(j => j.status === 'completed');

        for (const job of completedJobs) {
            results.checked++;
            const safeName = sanitize(job.name);
            const finalFile = path.join(DATA_DIR, `${safeName}.json`);
            const partialFile = path.join(DATA_DIR, 'partial', `${safeName}_partial.json`);

            try {
                // Check if final file exists
                const finalExists = await fs.access(finalFile).then(() => true).catch(() => false);
                const partialExists = await fs.access(partialFile).then(() => true).catch(() => false);

                if (!finalExists && partialExists) {
                    // Partial file exists but no final file - move partial to final
                    await fs.rename(partialFile, finalFile);
                    results.partialFound.push(job.name);
                    console.log(`📦 [${job.name}] Moved partial file to final location`);
                } else if (!finalExists && !partialExists) {
                    // No file at all - mark for re-scraping
                    job.status = 'pending';
                    job.retryCount = 0;
                    results.incomplete.push(job.name);
                    results.reset.push(job.name);
                    console.log(`⚠️ [${job.name}] No data found, reset to pending`);
                } else if (finalExists) {
                    // Validate final file is not empty/corrupted
                    const content = await fs.readFile(finalFile, 'utf8');
                    const data = JSON.parse(content);

                    if (!Array.isArray(data) || data.length === 0) {
                        // Empty or invalid data - mark for re-scraping
                        job.status = 'pending';
                        job.retryCount = 0;
                        results.incomplete.push(job.name);
                        results.reset.push(job.name);
                        console.log(`⚠️ [${job.name}] Empty/invalid data, reset to pending`);
                    }
                }
            } catch (err) {
                // Error reading file - mark for re-scraping
                job.status = 'pending';
                job.retryCount = 0;
                results.incomplete.push(job.name);
                results.reset.push(job.name);
                console.log(`❌ [${job.name}] Error validating: ${err.message}, reset to pending`);
            }
        }

        // Check for orphaned partial files (no corresponding job)
        try {
            const partialDir = path.join(DATA_DIR, 'partial');
            const partialDirExists = await fs.access(partialDir).then(() => true).catch(() => false);

            if (partialDirExists) {
                const partialFiles = await fs.readdir(partialDir);

                for (const file of partialFiles) {
                    if (file.endsWith('_partial.json')) {
                        const categoryName = file.replace('_partial.json', '');
                        const job = jobs.find(j => sanitize(j.name) === categoryName);

                        if (job && job.status === 'in_progress') {
                            // Reset stuck in_progress jobs that have partial data
                            job.status = 'pending';
                            job.retryCount = 0;
                            results.reset.push(job.name);
                            console.log(`🔄 [${job.name}] Found partial file, reset stuck job to pending`);
                        }
                    }
                }
            }
        } catch (err) {
            console.log('ℹ️ No partial directory found or error checking:', err.message);
        }

        // Save updated jobs
        if (results.reset.length > 0) {
            await saveJobs();
        }

        console.log(`✅ Validation complete. Checked: ${results.checked}, Reset: ${results.reset.length}`);

        // Send detailed report
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Data Validation Report</title>
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
                <style>
                    :root { --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); --accent: #38bdf8; --text: #f8fafc; --text-dim: #94a3b8; --success: #22c55e; --warning: #f59e0b; }
                    body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); padding: 40px; background-image: radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%); }
                    .container { max-width: 900px; margin: 0 auto; background: var(--card-bg); padding: 30px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); }
                    h1 { color: var(--accent); margin-bottom: 20px; }
                    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
                    .stat-box { background: rgba(0,0,0,0.2); padding: 15px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); }
                    .stat-box h3 { font-size: 0.8rem; color: var(--text-dim); margin-bottom: 5px; text-transform: uppercase; }
                    .stat-box .value { font-size: 2rem; font-weight: 700; color: var(--accent); }
                    .section { margin-bottom: 30px; }
                    .section h2 { font-size: 1.2rem; color: var(--text); margin-bottom: 15px; border-left: 4px solid var(--accent); padding-left: 15px; }
                    .list { background: rgba(0,0,0,0.2); padding: 15px; border-radius: 8px; }
                    .list-item { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
                    .list-item:last-child { border-bottom: none; }
                    .empty { color: var(--text-dim); font-style: italic; }
                    .back-btn { display: inline-block; margin-top: 20px; padding: 10px 20px; background: var(--accent); color: #000; text-decoration: none; border-radius: 8px; font-weight: 700; }
                    .back-btn:hover { background: #7dd3fc; }
                    .success { color: var(--success); }
                    .warning { color: var(--warning); }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🔍 Data Validation Report</h1>
                    
                    <div class="stats">
                        <div class="stat-box">
                            <h3>Categories Checked</h3>
                            <div class="value">${results.checked}</div>
                        </div>
                        <div class="stat-box">
                            <h3>Incomplete Found</h3>
                            <div class="value warning">${results.incomplete.length}</div>
                        </div>
                        <div class="stat-box">
                            <h3>Partial Files Found</h3>
                            <div class="value">${results.partialFound.length}</div>
                        </div>
                        <div class="stat-box">
                            <h3>Reset to Pending</h3>
                            <div class="value success">${results.reset.length}</div>
                        </div>
                    </div>
                    
                    ${results.reset.length > 0 ? `
                        <div class="section">
                            <h2>✅ Categories Reset to Pending</h2>
                            <div class="list">
                                ${results.reset.map(name => `<div class="list-item">• ${name}</div>`).join('')}
                            </div>
                            <p style="margin-top: 15px; color: var(--text-dim);">These categories will be re-scraped when you start a worker.</p>
                        </div>
                    ` : `
                        <div class="section">
                            <h2 class="success">✅ All Categories Valid</h2>
                            <p class="empty">No incomplete or corrupted data found. All categories are complete!</p>
                        </div>
                    `}
                    
                    ${results.partialFound.length > 0 ? `
                        <div class="section">
                            <h2>📦 Partial Files Moved to Final</h2>
                            <div class="list">
                                ${results.partialFound.map(name => `<div class="list-item">• ${name}</div>`).join('')}
                            </div>
                        </div>
                    ` : ''}
                    
                    <a href="http://localhost:3000/" class="back-btn">← Back to Dashboard</a>
                </div>
            </body>
            </html>
        `);

    } catch (err) {
        console.error('❌ Validation error:', err.message);
        res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
});


// --- 📂 Scan Partial Data and Resume ---
app.get('/scan-partial-data', async (req, res) => {
    try {
        console.log('📂 Scanning partial data folder...');

        const results = {
            partialFiles: [],
            reset: [],
            alreadyPending: [],
            notFound: []
        };

        const partialDir = path.join(DATA_DIR, 'partial');

        // Check if partial directory exists
        const partialDirExists = await fs.access(partialDir).then(() => true).catch(() => false);

        if (!partialDirExists) {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>No Partial Data</title>
                    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
                    <style>
                        :root { --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); --accent: #38bdf8; --text: #f8fafc; --text-dim: #94a3b8; }
                        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background-image: radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%); }
                        .card { background: var(--card-bg); padding: 3rem; border-radius: 1.5rem; border: 1px solid rgba(255,255,255,0.1); text-align: center; max-width: 500px; backdrop-filter: blur(10px); }
                        h1 { color: var(--accent); margin-bottom: 1rem; }
                        p { color: var(--text-dim); margin-bottom: 2rem; }
                        .btn { display: inline-block; padding: 0.8rem 2rem; background: var(--accent); color: #000; text-decoration: none; border-radius: 0.75rem; font-weight: 700; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>📂 No Partial Data Found</h1>
                        <p>The partial data folder doesn't exist or is empty.</p>
                        <a href="http://localhost:3000/" class="btn">← Back to Dashboard</a>
                    </div>
                </body>
                </html>
            `);
        }

        // Read all partial files
        const files = await fs.readdir(partialDir);
        const partialFiles = files.filter(f => f.endsWith('_partial.json'));

        if (partialFiles.length === 0) {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>No Partial Data</title>
                    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
                    <style>
                        :root { --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); --accent: #38bdf8; --text: #f8fafc; --text-dim: #94a3b8; --success: #22c55e; }
                        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background-image: radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%); }
                        .card { background: var(--card-bg); padding: 3rem; border-radius: 1.5rem; border: 1px solid rgba(255,255,255,0.1); text-align: center; max-width: 500px; backdrop-filter: blur(10px); }
                        .icon { font-size: 4rem; margin-bottom: 1rem; }
                        h1 { color: var(--success); margin-bottom: 1rem; }
                        p { color: var(--text-dim); margin-bottom: 2rem; }
                        .btn { display: inline-block; padding: 0.8rem 2rem; background: var(--accent); color: #000; text-decoration: none; border-radius: 0.75rem; font-weight: 700; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <div class="icon">✅</div>
                        <h1>All Clear!</h1>
                        <p>No partial data files found. All categories are either complete or pending.</p>
                        <a href="http://localhost:3000/" class="btn">← Back to Dashboard</a>
                    </div>
                </body>
                </html>
            `);
        }

        // Process each partial file
        for (const file of partialFiles) {
            const categoryName = file.replace('_partial.json', '');
            const job = jobs.find(j => sanitize(j.name) === categoryName);

            results.partialFiles.push(categoryName);

            if (!job) {
                results.notFound.push(categoryName);
                console.log(`⚠️ [${categoryName}] Partial file found but no job exists`);
                continue;
            }

            if (job.status === 'pending') {
                results.alreadyPending.push(job.name);
                console.log(`ℹ️ [${job.name}] Already pending, no action needed`);
            } else {
                // Reset to pending
                job.status = 'pending';
                job.retryCount = 0;
                job.updatedAt = new Date().toISOString();
                results.reset.push(job.name);
                console.log(`🔄 [${job.name}] Reset to pending for completion`);
            }
        }

        // Save updated jobs
        if (results.reset.length > 0) {
            await saveJobs();
        }

        console.log(`✅ Scan complete. Found: ${partialFiles.length}, Reset: ${results.reset.length}`);

        // Send detailed report with auto-start option
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Partial Data Scan Report</title>
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
                <style>
                    :root { --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); --accent: #38bdf8; --text: #f8fafc; --text-dim: #94a3b8; --success: #22c55e; --warning: #f59e0b; }
                    body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); padding: 40px; background-image: radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%); }
                    .container { max-width: 900px; margin: 0 auto; background: var(--card-bg); padding: 30px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); }
                    h1 { color: var(--accent); margin-bottom: 20px; }
                    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
                    .stat-box { background: rgba(0,0,0,0.2); padding: 15px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); }
                    .stat-box h3 { font-size: 0.8rem; color: var(--text-dim); margin-bottom: 5px; text-transform: uppercase; }
                    .stat-box .value { font-size: 2rem; font-weight: 700; color: var(--accent); }
                    .section { margin-bottom: 30px; }
                    .section h2 { font-size: 1.2rem; color: var(--text); margin-bottom: 15px; border-left: 4px solid var(--accent); padding-left: 15px; }
                    .list { background: rgba(0,0,0,0.2); padding: 15px; border-radius: 8px; max-height: 300px; overflow-y: auto; }
                    .list-item { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
                    .list-item:last-child { border-bottom: none; }
                    .btn-group { display: flex; gap: 15px; margin-top: 20px; }
                    .btn { padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 700; transition: all 0.3s; display: inline-block; }
                    .btn-primary { background: var(--success); color: #000; }
                    .btn-primary:hover { background: #16a34a; transform: translateY(-2px); }
                    .btn-secondary { background: rgba(255,255,255,0.05); color: var(--text); border: 1px solid rgba(255,255,255,0.1); }
                    .btn-secondary:hover { background: rgba(255,255,255,0.1); }
                    .highlight-box { background: linear-gradient(135deg, rgba(34, 197, 94, 0.1), rgba(56, 189, 248, 0.1)); padding: 20px; border-radius: 8px; border: 1px solid rgba(34, 197, 94, 0.3); margin-bottom: 20px; }
                    .highlight-box h3 { color: var(--success); margin-bottom: 10px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>📂 Partial Data Scan Report</h1>
                    
                    <div class="stats">
                        <div class="stat-box">
                            <h3>Partial Files Found</h3>
                            <div class="value">${results.partialFiles.length}</div>
                        </div>
                        <div class="stat-box">
                            <h3>Reset to Pending</h3>
                            <div class="value" style="color: var(--success);">${results.reset.length}</div>
                        </div>
                        <div class="stat-box">
                            <h3>Already Pending</h3>
                            <div class="value">${results.alreadyPending.length}</div>
                        </div>
                    </div>
                    
                    ${results.reset.length > 0 ? `
                        <div class="highlight-box">
                            <h3>🚀 Ready to Complete!</h3>
                            <p style="color: var(--text-dim); margin-bottom: 15px;">Found ${results.reset.length} categories with partial data. Click below to start a worker and complete them automatically.</p>
                            <a href="/start-worker" class="btn btn-primary">🚀 Start Worker & Complete Data</a>
                        </div>
                    ` : ''}
                    
                    ${results.reset.length > 0 ? `
                        <div class="section">
                            <h2>🔄 Categories Reset to Pending</h2>
                            <div class="list">
                                ${results.reset.map(name => `<div class="list-item">• ${name}</div>`).join('')}
                            </div>
                            <p style="margin-top: 15px; color: var(--text-dim);">These categories have partial data and will be completed when you start a worker. The worker will automatically load the existing data and scrape only the missing products.</p>
                        </div>
                    ` : ''}
                    
                    ${results.alreadyPending.length > 0 ? `
                        <div class="section">
                            <h2>ℹ️ Already Pending</h2>
                            <div class="list">
                                ${results.alreadyPending.map(name => `<div class="list-item">• ${name}</div>`).join('')}
                            </div>
                        </div>
                    ` : ''}
                    
                    <div class="btn-group">
                        <a href="http://localhost:3000/" class="btn btn-secondary">← Back to Dashboard</a>
                        ${results.reset.length > 0 ? `<a href="/worker-monitor" class="btn btn-secondary">📊 Monitor Progress</a>` : ''}
                    </div>
                </div>
            </body>
            </html>
        `);

    } catch (err) {
        console.error('❌ Scan error:', err.message);
        res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
});


// Helper to render a consistent premium success/action page
function renderActionPage(title, message, icon = '✅') {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>${title}</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
            <style>
                :root { --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); --accent: #38bdf8; --text: #f8fafc; --text-dim: #94a3b8; --success: #22c55e; }
                body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background-image: radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%); }
                .card { background: var(--card-bg); padding: 3rem; border-radius: 1.5rem; border: 1px solid rgba(255,255,255,0.1); text-align: center; max-width: 500px; width: 90%; backdrop-filter: blur(10px); box-shadow: 0 20px 50px rgba(0,0,0,0.5); animation: zoomIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
                @keyframes zoomIn { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
                .icon { font-size: 4rem; margin-bottom: 1.5rem; display: block; filter: drop-shadow(0 0 15px rgba(56, 189, 248, 0.4)); }
                h1 { color: #fff; margin-bottom: 0.5rem; font-size: 1.8rem; }
                p { color: var(--text-dim); margin-bottom: 2rem; font-size: 1.1rem; }
                .btn { display: inline-block; padding: 0.8rem 2rem; background: var(--accent); color: #000; text-decoration: none; border-radius: 0.75rem; font-weight: 700; transition: all 0.3s; }
                .btn:hover { transform: translateY(-2px); box-shadow: 0 10px 20px rgba(56, 189, 248, 0.3); background: #7dd3fc; }
            </style>
        </head>
        <body>
            <div class="card">
                <span class="icon">${icon}</span>
                <h1>${title}</h1>
                <p>${message}</p>
                <a href="http://localhost:3000/" class="btn">Back to Dashboard</a>
            </div>
        </body>
        </html>
    `;
}

// Reset jobs stuck in 'in_progress' for more than 30 minutes
app.get('/reset-stuck', async (req, res) => {
    const now = new Date();
    const TIMEOUT = 30 * 60 * 1000; // 30 minutes
    const stuckJobs = jobs.filter(j =>
        j.status === 'in_progress' &&
        j.updatedAt &&
        (now - new Date(j.updatedAt)) > TIMEOUT
    );

    stuckJobs.forEach(j => {
        j.status = 'pending';
        j.workerId = null;
        j.updatedAt = new Date().toISOString();
    });

    if (stuckJobs.length > 0) await saveJobs();

    if (stuckJobs.length > 0) console.log(`🔄 Reset ${stuckJobs.length} stuck jobs.`);
    res.send(renderActionPage('System Purged', `Successfully reset <b>${stuckJobs.length}</b> stuck categories back to pending status.`, '🔄'));
});

// Force reset ALL 'in_progress' and 'failed' jobs to 'pending'
app.get('/reset-all', async (req, res) => {
    const targetJobs = jobs.filter(j => j.status === 'in_progress' || j.status === 'failed');

    targetJobs.forEach(j => {
        j.status = 'pending';
        j.workerId = null;
        j.updatedAt = new Date().toISOString();
    });

    if (targetJobs.length > 0) await saveJobs();

    if (targetJobs.length > 0) console.log(`🔄 Force reset ${targetJobs.length} jobs to pending.`);
    res.send(renderActionPage('Full Reset Complete', `All <b>${targetJobs.length}</b> active and failed categories have been returned to pending.`, '⚠️'));
});

// Reset only FAILED jobs and start a worker
app.get('/retry-failed', async (req, res) => {
    const failedJobs = jobs.filter(j => j.status === 'failed');

    failedJobs.forEach(j => {
        j.status = 'pending';
        j.workerId = null;
        j.updatedAt = new Date().toISOString();
        j.retryCount = 0; // Reset retry counter to give them another 3 tries
    });

    if (failedJobs.length > 0) {
        await saveJobs();
        console.log(`🔄 Reset ${failedJobs.length} FAILED jobs to pending.`);

        // Trigger a local worker to handle them
        const worker = spawn('node', ['worker.js'], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env }
        });
        worker.unref();
        console.log(`🚀 Started local worker to retry failed jobs.`);

        res.send(renderActionPage('Retry Initialized', `Reset <b>${failedJobs.length}</b> failed categories. A local worker has been spawned to process them.`, '🚀'));
    } else {
        res.send(renderActionPage('No Failures Found', 'All categories are currently in healthy states (pending, working, or completed).', '✨'));
    }
});

// Helper to push a SINGLE record to an external API
async function pushRecordToExternalApi(categoryName, productData) {
    try {
        await axios.post(EXTERNAL_API_URL, {
            category: categoryName,
            scrapedAt: new Date().toISOString(),
            ...productData // Send the complete details of the individual record
        });
        return true;
    } catch (err) {
        console.error(`❌ [${categoryName}] Record push failed: ${err.message}`);
        return false;
    }
}

// Helper to push all records of a category one by one
async function pushCategoryRecordsOneByOne(job, res) {
    try {
        const safeName = job.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const fileName = path.join(DATA_DIR, `${safeName}.json`);
        const productList = JSON.parse(await fs.readFile(fileName, 'utf8'));

        console.log(`📤 Pushing ${productList.length} records for [${job.name}] one by one...`);
        if (res) res.write(`<p>Pushing ${productList.length} records for <b>${job.name}</b>...</p>`);

        let successCount = 0;
        for (const product of productList) {
            const success = await pushRecordToExternalApi(job.name, product);
            if (success) successCount++;
        }

        console.log(`✅ [${job.name}] Finished. Success: ${successCount}/${productList.length}`);
        if (res) res.write(`<p>✅ ${job.name}: ${successCount}/${productList.length} records pushed.</p>`);
        return true;
    } catch (err) {
        console.error(`❌ [${job.name}] Error pushing records: ${err.message}`);
        if (res) res.write(`<p>🔴 ${job.name}: Error - ${err.message}</p>`);
        return false;
    }
}

// Endpoint to manually push all COMPLETED data to external API (RECORD BY RECORD)
app.get('/push-all', async (req, res) => {
    const completedJobs = jobs.filter(j => j.status === 'completed');
    if (completedJobs.length === 0) {
        return res.send(`<h1>No Data to Push</h1><p>No categories are marked as 'completed' yet.</p>`);
    }

    res.write(`<h1>Starting One-by-One Push...</h1><p>Checking ${completedJobs.length} categories...</p>`);

    for (const job of completedJobs) {
        await pushCategoryRecordsOneByOne(job, res);
    }
    res.end(`<p><b>All pushes finished.</b></p>`);
});

// Endpoint to manually push a SPECIFIC category to external API (RECORD BY RECORD)
app.get('/push-category', async (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).send('<h1>Error</h1><p>Query parameter "name" is required.</p>');

    const job = jobs.find(j => j.name === name || j.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() === name.toLowerCase());
    if (!job || job.status !== 'completed') {
        return res.status(404).send(`<h1>Error</h1><p>Category "${name}" not found or not completed.</p>`);
    }

    res.write(`<h1>Starting Push for ${job.name}...</h1>`);
    await pushCategoryRecordsOneByOne(job, res);
    res.end(`<p><b>Push finished.</b> Check server console for details.</p>`);
});

// Endpoint to start a local worker via browser
app.get('/start-worker', (req, res) => {
    const { proxy, limit } = req.query; // Optional proxy URL or limit

    const env = { ...process.env };
    if (proxy) env.PROXY_URL = proxy;
    if (limit) env.LIMIT = limit;

    const worker = spawn('node', ['worker.js'], {
        detached: true,
        stdio: 'ignore',
        env
    });

    worker.unref();

    let message = `🚀 Triggered a local worker process.`;
    if (proxy) message += ` Proxy: ${proxy}.`;
    if (limit) message += ` Limit: ${limit} categories.`;

    console.log(message);

    // Send live monitoring UI instead of simple message
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Worker Live Monitor - Somacy</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
            <style>
                :root {
                    --bg: #0f172a;
                    --card-bg: rgba(30, 41, 59, 0.7);
                    --accent: #38bdf8;
                    --text: #f8fafc;
                    --text-dim: #94a3b8;
                    --success: #22c55e;
                    --warning: #f59e0b;
                    --working: #8b5cf6;
                }

                * { box-sizing: border-box; margin: 0; padding: 0; }
                body {
                    font-family: 'Inter', sans-serif;
                    background: var(--bg);
                    color: var(--text);
                    line-height: 1.6;
                    background-image: radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%);
                    min-height: 100vh;
                    padding: 2rem;
                }
                .container { max-width: 1200px; margin: 0 auto; }
                
                header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 2rem;
                    backdrop-filter: blur(10px);
                    padding: 1.5rem;
                    border-radius: 1rem;
                    background: var(--card-bg);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }
                .logo-area h1 { font-size: 1.5rem; font-weight: 700; color: var(--accent); }
                .logo-area p { font-size: 0.875rem; color: var(--text-dim); margin-top: 0.25rem; }
                
                .back-btn {
                    padding: 0.5rem 1rem;
                    background: rgba(255,255,255,0.05);
                    color: var(--text);
                    text-decoration: none;
                    border-radius: 0.5rem;
                    font-size: 0.875rem;
                    border: 1px solid rgba(255,255,255,0.1);
                    transition: all 0.3s;
                }
                .back-btn:hover { background: rgba(255,255,255,0.1); }

                .status-banner {
                    background: linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(56, 189, 248, 0.2));
                    padding: 1.5rem;
                    border-radius: 1rem;
                    border: 1px solid rgba(139, 92, 246, 0.3);
                    margin-bottom: 2rem;
                    text-align: center;
                }
                .status-banner h2 { color: var(--accent); margin-bottom: 0.5rem; }
                .status-banner p { color: var(--text-dim); font-size: 0.9rem; }

                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 1rem;
                    margin-bottom: 2rem;
                }
                .stat-box {
                    background: var(--card-bg);
                    padding: 1.25rem;
                    border-radius: 0.75rem;
                    border: 1px solid rgba(255, 255, 255, 0.05);
                }
                .stat-box h3 { font-size: 0.75rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
                .stat-box .value { font-size: 2rem; font-weight: 700; color: var(--accent); }

                .worker-card {
                    background: var(--card-bg);
                    padding: 1.5rem;
                    border-radius: 1rem;
                    border: 1px solid rgba(255, 255, 255, 0.05);
                    margin-bottom: 1.5rem;
                }
                
                .worker-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: 1rem;
                    padding-bottom: 1rem;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
                }
                .worker-id {
                    font-size: 0.9rem;
                    font-weight: 600;
                    color: var(--text);
                    font-family: monospace;
                }
                .worker-status {
                    padding: 0.25rem 0.75rem;
                    border-radius: 1rem;
                    font-size: 0.7rem;
                    font-weight: 700;
                    text-transform: uppercase;
                }
                .status-working { background: rgba(139, 92, 246, 0.1); color: var(--working); border: 1px solid rgba(139, 92, 246, 0.2); }
                .status-starting { background: rgba(245, 158, 11, 0.1); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.2); }
                .status-completed { background: rgba(34, 197, 94, 0.1); color: var(--success); border: 1px solid rgba(34, 197, 94, 0.2); }

                .category-info {
                    margin-bottom: 1rem;
                }
                .category-label {
                    font-size: 0.75rem;
                    color: var(--text-dim);
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin-bottom: 0.25rem;
                }
                .category-name {
                    font-size: 1.2rem;
                    font-weight: 600;
                    color: #fff;
                    margin-bottom: 0.5rem;
                }
                .category-url {
                    font-size: 0.75rem;
                    color: var(--text-dim);
                    word-break: break-all;
                    font-family: monospace;
                }

                .progress-section {
                    margin-top: 1rem;
                }
                .progress-label {
                    display: flex;
                    justify-content: space-between;
                    font-size: 0.85rem;
                    color: var(--text-dim);
                    margin-bottom: 0.5rem;
                }
                .progress-count {
                    font-weight: 600;
                    color: var(--accent);
                }
                .progress-bar-container {
                    width: 100%;
                    height: 10px;
                    background: rgba(0,0,0,0.3);
                    border-radius: 1rem;
                    overflow: hidden;
                }
                .progress-bar {
                    height: 100%;
                    background: linear-gradient(90deg, var(--accent), var(--working));
                    border-radius: 1rem;
                    transition: width 0.5s ease;
                }

                .last-update {
                    margin-top: 1rem;
                    font-size: 0.75rem;
                    color: var(--text-dim);
                    text-align: right;
                }

                .empty-state {
                    text-align: center;
                    padding: 3rem 2rem;
                    background: var(--card-bg);
                    border-radius: 1rem;
                    border: 1px solid rgba(255, 255, 255, 0.05);
                }
                .empty-state .icon { font-size: 3rem; margin-bottom: 1rem; opacity: 0.3; }
                .empty-state h3 { color: var(--text-dim); margin-bottom: 0.5rem; }
                .empty-state p { color: var(--text-dim); font-size: 0.85rem; }

                .pulse-dot {
                    display: inline-block;
                    width: 8px;
                    height: 8px;
                    background: var(--success);
                    border-radius: 50%;
                    margin-right: 0.5rem;
                    animation: pulse 2s infinite;
                }
                @keyframes pulse {
                    0% { opacity: 1; transform: scale(1); }
                    50% { opacity: 0.5; transform: scale(1.2); }
                    100% { opacity: 1; transform: scale(1); }
                }

                .log-section {
                    background: var(--card-bg);
                    padding: 1.5rem;
                    border-radius: 1rem;
                    border: 1px solid rgba(255, 255, 255, 0.05);
                    margin-top: 2rem;
                }
                .log-section h3 {
                    font-size: 1rem;
                    color: var(--text);
                    margin-bottom: 1rem;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                }
                .log-entry {
                    padding: 0.75rem;
                    background: rgba(0,0,0,0.2);
                    border-radius: 0.5rem;
                    margin-bottom: 0.5rem;
                    font-family: monospace;
                    font-size: 0.85rem;
                    border-left: 3px solid var(--accent);
                }
                .log-time {
                    color: var(--text-dim);
                    margin-right: 0.5rem;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <header>
                    <div class="logo-area">
                        <h1>🚀 Worker Live Monitor</h1>
                        <p>Real-time scraping progress</p>
                    </div>
                    <a href="http://localhost:3000/" class="back-btn">← Back to Dashboard</a>
                </header>

                <div class="status-banner">
                    <h2>✅ Worker Started Successfully</h2>
                    <p>${message}</p>
                </div>

                <div class="stats-grid">
                    <div class="stat-box">
                        <h3>Current Category</h3>
                        <div class="value" id="currentCategory" style="font-size: 1.2rem;">Initializing...</div>
                    </div>
                    <div class="stat-box">
                        <h3>Products Scraped</h3>
                        <div class="value" id="productsScraped">0</div>
                    </div>
                    <div class="stat-box">
                        <h3>Progress</h3>
                        <div class="value" id="progressPercent">0%</div>
                    </div>
                </div>

                <div id="workerDetails">
                    <div class="empty-state">
                        <div class="icon">⏳</div>
                        <h3>Worker Initializing...</h3>
                        <p>Waiting for the worker to start scraping. This may take a few seconds.</p>
                    </div>
                </div>

                <div class="log-section">
                    <h3>
                        <span class="pulse-dot"></span>
                        Live Activity Log
                    </h3>
                    <div id="logContainer">
                        <div class="log-entry">
                            <span class="log-time">${new Date().toLocaleTimeString()}</span>
                            Worker process spawned and detached
                        </div>
                        <div class="log-entry">
                            <span class="log-time">${new Date().toLocaleTimeString()}</span>
                            Waiting for first progress report...
                        </div>
                    </div>
                </div>
            </div>

            <script>
                let lastLogCount = 2;
                
                function formatTime(isoString) {
                    const date = new Date(isoString);
                    const now = new Date();
                    const diffMs = now - date;
                    const diffSec = Math.floor(diffMs / 1000);
                    
                    if (diffSec < 60) return \`\${diffSec}s ago\`;
                    if (diffSec < 3600) return \`\${Math.floor(diffSec / 60)}m ago\`;
                    return date.toLocaleTimeString();
                }

                function addLog(message) {
                    const logContainer = document.getElementById('logContainer');
                    const entry = document.createElement('div');
                    entry.className = 'log-entry';
                    entry.innerHTML = \`
                        <span class="log-time">\${new Date().toLocaleTimeString()}</span>
                        \${message}
                    \`;
                    logContainer.appendChild(entry);
                    
                    // Keep only last 10 logs
                    while (logContainer.children.length > 10) {
                        logContainer.removeChild(logContainer.firstChild);
                    }
                    
                    // Scroll to bottom
                    logContainer.lastChild.scrollIntoView({ behavior: 'smooth' });
                }

                async function updateWorkerStatus() {
                    try {
                        const response = await fetch('/worker-status');
                        const workers = await response.json();
                        
                        const workerIds = Object.keys(workers);
                        const container = document.getElementById('workerDetails');
                        
                        if (workerIds.length === 0) {
                            // Still waiting
                            return;
                        }

                        // Get the first (and likely only) worker
                        const workerId = workerIds[0];
                        const w = workers[workerId];
                        
                        // Update stats
                        document.getElementById('currentCategory').textContent = w.categoryName || 'Unknown';
                        document.getElementById('productsScraped').textContent = w.currentProduct || 0;
                        const progress = w.totalProducts > 0 ? Math.round((w.currentProduct / w.totalProducts) * 100) : 0;
                        document.getElementById('progressPercent').textContent = progress + '%';

                        // Log significant events
                        if (w.status === 'starting' && lastLogCount === 2) {
                            addLog(\`📂 Started scraping category: \${w.categoryName}\`);
                            lastLogCount++;
                        } else if (w.status === 'working' && w.totalProducts > 0) {
                            if (w.currentProduct === 0 && lastLogCount === 3) {
                                addLog(\`🔍 Found \${w.totalProducts} products in this category\`);
                                lastLogCount++;
                            } else if (w.currentProduct > 0 && w.currentProduct % 10 === 0) {
                                addLog(\`✅ Scraped \${w.currentProduct}/\${w.totalProducts} products\`);
                            }
                        } else if (w.status === 'completed') {
                            addLog(\`🎉 Completed category: \${w.categoryName} (\${w.currentProduct} products)\`);
                        }

                        const statusClass = w.status === 'completed' ? 'status-completed' : 
                                          w.status === 'starting' ? 'status-starting' : 'status-working';
                        
                        container.innerHTML = \`
                            <div class="worker-card">
                                <div class="worker-header">
                                    <div class="worker-id">
                                        <span class="pulse-dot"></span>
                                        \${workerId}
                                    </div>
                                    <div class="worker-status \${statusClass}">\${w.status}</div>
                                </div>
                                <div class="category-info">
                                    <div class="category-label">Currently Scraping</div>
                                    <div class="category-name">\${w.categoryName || 'Unknown Category'}</div>
                                    <div class="category-url">\${w.categoryUrl || ''}</div>
                                </div>
                                <div class="progress-section">
                                    <div class="progress-label">
                                        <span>Scraping Progress</span>
                                        <span class="progress-count">\${w.currentProduct || 0} / \${w.totalProducts || 0} products</span>
                                    </div>
                                    <div class="progress-bar-container">
                                        <div class="progress-bar" style="width: \${progress}%"></div>
                                    </div>
                                </div>
                                <div class="last-update">Last update: \${formatTime(w.lastUpdate)}</div>
                            </div>
                        \`;
                        
                    } catch (err) {
                        console.error('Error fetching worker status:', err);
                    }
                }

                // Update every 2 seconds
                updateWorkerStatus();
                const interval = setInterval(updateWorkerStatus, 2000);
            </script>
        </body>
        </html>
    `);
});
// Endpoint to aggregate all JSON results into a multi-sheet Excel file
app.get('/get-excel', async (req, res) => {
    try {
        const files = await fs.readdir(DATA_DIR);
        const jsonFiles = files.filter(f => f.endsWith('.json'));

        if (jsonFiles.length === 0) {
            return res.status(404).send('<h1>No Data Found</h1><p>No scraped JSON files found in the data folder.</p>');
        }

        console.log(`📊 Aggregating ${jsonFiles.length} files into multi-sheet Excel...`);

        const wb = XLSX.utils.book_new();

        // Helper to format medicine data into Excel-ready rows
        const mapToRows = (productList) => productList.map(med => {
            const joinArray = (arr, sep = '\n') => Array.isArray(arr) ? arr.filter(Boolean).join(sep) : (arr || '');
            const faqs = Array.isArray(med.faqs) ? med.faqs.map(f => `${f.question || ''}\n${f.answer || ''}`).filter(qa => qa.trim() !== '\n').join('\n\n') : (med.faqs || '');
            const synopsis = med.synopsis && typeof med.synopsis === 'object' ? Object.entries(med.synopsis).map(([k, v]) => `${k}: ${v}`).join('\n') : '';
            const warnings = Array.isArray(med.warnings) ? med.warnings.map(w => `[${w.category}] ${w.status || ''}\n${w.details || ''}`).join('\n\n') : '';

            // Calculate Local Image Path
            const categoryName = Array.isArray(med.category) ? med.category[med.category.length - 1] : '';
            const localImgPath = med.images?.length > 0
                ? path.join('images', sanitize(categoryName), sanitize(med.name))
                : 'No Images';

            return {
                'URL': med.url || '',
                'Name': med.name || '',
                'Brand': med.brand || '',
                'Prescription Required': med.isPrescriptionRequired ? 'Yes' : 'No',
                'Category': joinArray(med.category, ', '),
                'Composition': med.composition || '',
                'Pack Info': med.packInfo || '',
                'MRP': med.price?.mrp || '',
                'Discounted Price': med.price?.discountedPrice || '',
                'Best Price': med.price?.bestPrice || '',
                'Introduction': med.introduction || '',
                'Uses (List)': joinArray(med.uses),
                'Uses (Detailed)': med.usesDetails || '',
                'Mechanism of Action': med.mechanismOfAction || '',
                'Usage Instructions (List)': joinArray(med.usageInstructions),
                'Usage Instructions (Detailed)': med.usageDetails || '',
                'Side Effects (List)': joinArray(med.sideEffects),
                'Side Effects (Detailed)': med.sideEffectsDetails || '',
                'Warnings (Structured)': warnings,
                'Warnings (Full Text)': med.warningsRaw || '',
                'Interactions': med.interactions || '',
                'Synopsis': synopsis,
                'More Info': med.moreInfo || '',
                'References': joinArray(med.references),
                'FAQs': faqs,
                'Images': joinArray(med.images, '\n'),
                'Local Image Path': localImgPath,
                'Author': med.author || '',
                'Last Updated': med.lastUpdated || ''
            };
        });

        // Common Header
        const header = [
            'URL', 'Name', 'Brand', 'Prescription Required', 'Category', 'Composition',
            'Pack Info', 'MRP', 'Discounted Price', 'Best Price', 'Introduction',
            'Uses (List)', 'Uses (Detailed)', 'Mechanism of Action',
            'Usage Instructions (List)', 'Usage Instructions (Detailed)',
            'Side Effects (List)', 'Side Effects (Detailed)',
            'Warnings (Structured)', 'Warnings (Full Text)',
            'Interactions', 'Synopsis', 'More Info', 'References', 'FAQs', 'Images', 'Local Image Path', 'Author', 'Last Updated'
        ];

        let totalRecords = 0;

        for (const file of jsonFiles) {
            try {
                const content = await fs.readFile(path.join(DATA_DIR, file), 'utf8');
                const data = JSON.parse(content);
                if (Array.isArray(data) && data.length > 0) {
                    const rows = mapToRows(data);
                    const ws = XLSX.utils.json_to_sheet(rows, { header });

                    // Sanitize sheet name: Max 31 chars, no special chars
                    let sheetName = file.replace('.json', '').substring(0, 31).replace(/[\[\]\*\?\/\\]/g, '_');

                    // Add to workbook
                    XLSX.utils.book_append_sheet(wb, ws, sheetName);
                    totalRecords += data.length;
                }
            } catch (fileErr) {
                console.error(`⚠️ Skipping ${file} due to error:`, fileErr.message);
            }
        }

        if (wb.SheetNames.length === 0) {
            return res.status(404).send('<h1>Empty Export</h1><p>No valid data found to export across categories.</p>');
        }

        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename=Netmeds_Scraper_Export_MultiSheet.xlsx');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);

        console.log(`✅ Multi-sheet Excel download served. Total sheets: ${wb.SheetNames.length}, Total records: ${totalRecords}`);

    } catch (err) {
        console.error('❌ Excel Export Error:', err.message);
        res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
});

// Endpoint to download images for all completed categories
app.get('/download-images', async (req, res) => {
    try {
        isStoppingImages = false; // Reset stop flag on start
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const completedJobs = jobs.filter(j => j.status === 'completed');

        if (completedJobs.length === 0) {
            return res.send(`
                <html>
                <head>
                    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
                    <style>
                        body { font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                        .card { background: rgba(30, 41, 59, 0.7); padding: 2rem; border-radius: 1rem; border: 1px solid rgba(255,255,255,0.1); text-align: center; }
                        a { color: #38bdf8; text-decoration: none; font-weight: 600; margin-top: 1rem; display: inline-block; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>📂 No Data to Download</h1>
                        <p>No categories are marked as "completed" yet.</p>
                        <a href="http://localhost:3000/">← Back to Dashboard</a>
                    </div>
                </body>
                </html>
            `);
        }

        // Send Initial Styled Layout
        res.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Downloading Images...</title>
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
                <style>
                    :root { --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); --accent: #38bdf8; --text: #f8fafc; --success: #22c55e; --danger: #ef4444; }
                    body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); padding: 40px; line-height: 1.6; }
                    .container { max-width: 900px; margin: 0 auto; }
                    header { margin-bottom: 30px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-end; }
                    h1 { color: var(--accent); margin: 0; font-size: 1.8rem; }
                    .controls { display: flex; gap: 15px; align-items: center; }
                    .back-btn { color: var(--text); text-decoration: none; font-size: 0.9rem; opacity: 0.7; }
                    .back-btn:hover { opacity: 1; color: var(--accent); }
                    .stop-btn { background: var(--danger); color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 0.85rem; transition: all 0.2s; border: none; cursor: pointer; }
                    .stop-btn:hover { background: #dc2626; transform: scale(1.05); }
                    #log { display: flex; flex-direction: column; gap: 12px; }
                    .entry { background: var(--card-bg); padding: 15px 20px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.05); display: flex; align-items: center; gap: 15px; animation: slideIn 0.3s ease-out; }
                    @keyframes slideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
                    .icon { font-size: 1.2rem; }
                    .details { flex-grow: 1; }
                    .category-name { font-weight: 600; color: #fff; }
                    .count { font-size: 0.85rem; color: #94a3b8; }
                    .status-pill { font-size: 0.7rem; font-weight: 700; padding: 3px 8px; border-radius: 4px; text-transform: uppercase; }
                    .status-working { background: rgba(56, 189, 248, 0.1); color: var(--accent); border: 1px solid rgba(56, 189, 248, 0.2); }
                    .status-done { background: rgba(34, 197, 129, 0.1); color: var(--success); border: 1px solid rgba(34, 197, 129, 0.2); }
                    .status-stopped { background: rgba(239, 68, 68, 0.1); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.2); }
                </style>
                <script>
                    function scrollToBottom() { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }
                    async function stopProcessing() {
                        const btn = document.getElementById('stopBtn');
                        btn.innerText = 'Stopping...';
                        btn.style.opacity = '0.5';
                        await fetch('/stop-images');
                    }
                </script>
            </head>
            <body>
                <div class="container">
                    <header>
                        <div>
                            <h1>📸 Image Downloader</h1>
                            <p style="color:#94a3b8; margin-top:5px;">Processing ${completedJobs.length} completed categories...</p>
                        </div>
                        <div class="controls">
                            <button id="stopBtn" onclick="stopProcessing()" class="stop-btn">🛑 Stop Downloader</button>
                            <a href="http://localhost:3000/" class="back-btn">← Back to Dashboard</a>
                        </div>
                    </header>
                    <div id="log">
        `);

        for (const job of completedJobs) {
            if (isStoppingImages) {
                res.write(`
                    <div class="entry" style="border-color: rgba(239, 68, 68, 0.4);">
                        <div class="icon">🛑</div>
                        <div class="details">
                            <div class="category-name">Download Stopped</div>
                            <div class="count">User requested a stop. Submitting final logs...</div>
                        </div>
                        <div class="status-pill status-stopped">Stopped</div>
                    </div>
                `);
                break;
            }

            try {
                const safeName = sanitize(job.name);
                const fileName = path.join(DATA_DIR, `${safeName}.json`);
                const productList = JSON.parse(await fs.readFile(fileName, 'utf8'));

                res.write(`
                    <div class="entry">
                        <div class="icon">📁</div>
                        <div class="details">
                            <div class="category-name">${job.name}</div>
                            <div class="count">Scanning ${productList.length} products (Resuming enabled)...</div>
                        </div>
                        <div class="status-pill status-working">Working</div>
                    </div>
                `);

                for (const prod of productList) {
                    if (isStoppingImages) break;
                    if (prod.images && Array.isArray(prod.images)) {
                        const prodFolder = path.join(IMG_DIR, sanitize(job.name), sanitize(prod.name));
                        for (let i = 0; i < prod.images.length; i++) {
                            const imgUrl = prod.images[i];
                            const ext = imgUrl.split('.').pop().split('?')[0] || 'jpg';
                            const imgName = `image_${i + 1}.${ext}`;
                            await downloadImage(imgUrl, prodFolder, imgName);
                        }
                    }
                }

                if (!isStoppingImages) {
                    res.write(`
                        <div class="entry" style="border-color: rgba(34, 197, 94, 0.3);">
                            <div class="icon">✅</div>
                            <div class="details">
                                <div class="category-name">${job.name}</div>
                                <div class="count">Finished/Resumed all ${productList.length} items.</div>
                            </div>
                            <div class="status-pill status-done">Finished</div>
                        </div>
                        <script>scrollToBottom();</script>
                    `);
                }
            } catch (err) {
                res.write(`
                    <div class="entry" style="border-color: rgba(239, 68, 68, 0.3); background: rgba(239, 68, 68, 0.05);">
                        <div class="icon">🔴</div>
                        <div class="details">
                            <div class="category-name">${job.name}</div>
                            <div class="count" style="color:#f87171;">Error: ${err.message}</div>
                        </div>
                        <div class="status-pill" style="background:rgba(239, 68, 68, 0.1); color:#f87171; border:1px solid rgba(239, 68, 68, 0.2);">Error</div>
                    </div>
                `);
            }
        }

        const finalStatus = isStoppingImages ? '🛑 Download Paused by User' : '✨ All Downloads Completed!';
        const finalColor = isStoppingImages ? 'var(--danger)' : 'var(--success)';

        res.write(`
                    </div>
                    <div style="margin-top:50px; text-align:center; padding:30px; border-top:1px solid rgba(255,255,255,0.1);">
                        <h2 style="color:${finalColor};">${finalStatus}</h2>
                        <p style="color:#94a3b8;">${isStoppingImages ? 'You can resume anytime by clicking "Download Images" again.' : 'You can find all images in the <code>/images</code> folder.'}</p>
                        <a href="http://localhost:3000/" style="display:inline-block; margin-top:20px; padding:10px 25px; background:var(--accent); color:#000; text-decoration:none; border-radius:8px; font-weight:700;">Return to Dashboard</a>
                    </div>
                </div>
            </body>
            </html>
        `);
        res.end();
    } catch (err) {
        console.error('❌ Image Downloader Error:', err.message);
        res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
});

// Endpoint to stop the image download
app.get('/stop-images', (req, res) => {
    isStoppingImages = true;
    res.json({ success: true, message: 'Stop flag set' });
});


// --- 🖥️ Worker Monitor UI ---
app.get('/worker-monitor', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Worker Monitor - Somacy</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
            <style>
                :root {
                    --bg: #0f172a;
                    --card-bg: rgba(30, 41, 59, 0.7);
                    --accent: #38bdf8;
                    --text: #f8fafc;
                    --text-dim: #94a3b8;
                    --success: #22c55e;
                    --warning: #f59e0b;
                    --working: #8b5cf6;
                }

                * { box-sizing: border-box; margin: 0; padding: 0; }
                body {
                    font-family: 'Inter', sans-serif;
                    background: var(--bg);
                    color: var(--text);
                    line-height: 1.6;
                    background-image: radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%);
                    min-height: 100vh;
                    padding: 2rem;
                }
                .container { max-width: 1400px; margin: 0 auto; }
                
                header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 2rem;
                    backdrop-filter: blur(10px);
                    padding: 1.5rem;
                    border-radius: 1rem;
                    background: var(--card-bg);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }
                .logo-area h1 { font-size: 1.5rem; font-weight: 700; color: var(--accent); }
                .logo-area p { font-size: 0.875rem; color: var(--text-dim); margin-top: 0.25rem; }
                
                .back-btn {
                    padding: 0.5rem 1rem;
                    background: rgba(255,255,255,0.05);
                    color: var(--text);
                    text-decoration: none;
                    border-radius: 0.5rem;
                    font-size: 0.875rem;
                    border: 1px solid rgba(255,255,255,0.1);
                    transition: all 0.3s;
                }
                .back-btn:hover { background: rgba(255,255,255,0.1); }

                .stats-bar {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 1rem;
                    margin-bottom: 2rem;
                }
                .stat-box {
                    background: var(--card-bg);
                    padding: 1.25rem;
                    border-radius: 0.75rem;
                    border: 1px solid rgba(255, 255, 255, 0.05);
                }
                .stat-box h3 { font-size: 0.75rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
                .stat-box .value { font-size: 2rem; font-weight: 700; color: var(--accent); }

                .workers-grid {
                    display: grid;
                    gap: 1.5rem;
                }
                
                .worker-card {
                    background: var(--card-bg);
                    padding: 1.5rem;
                    border-radius: 1rem;
                    border: 1px solid rgba(255, 255, 255, 0.05);
                    transition: all 0.3s;
                }
                .worker-card:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
                
                .worker-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: 1rem;
                }
                .worker-id {
                    font-size: 0.9rem;
                    font-weight: 600;
                    color: var(--text);
                    font-family: monospace;
                }
                .worker-status {
                    padding: 0.25rem 0.75rem;
                    border-radius: 1rem;
                    font-size: 0.7rem;
                    font-weight: 700;
                    text-transform: uppercase;
                }
                .status-working { background: rgba(139, 92, 246, 0.1); color: var(--working); border: 1px solid rgba(139, 92, 246, 0.2); }
                .status-idle { background: rgba(148, 163, 184, 0.1); color: var(--text-dim); border: 1px solid rgba(148, 163, 184, 0.2); }
                .status-completed { background: rgba(34, 197, 94, 0.1); color: var(--success); border: 1px solid rgba(34, 197, 94, 0.2); }

                .category-info {
                    margin-bottom: 1rem;
                }
                .category-name {
                    font-size: 1.1rem;
                    font-weight: 600;
                    color: #fff;
                    margin-bottom: 0.25rem;
                }
                .category-url {
                    font-size: 0.75rem;
                    color: var(--text-dim);
                    word-break: break-all;
                }

                .progress-section {
                    margin-top: 1rem;
                }
                .progress-label {
                    display: flex;
                    justify-content: space-between;
                    font-size: 0.85rem;
                    color: var(--text-dim);
                    margin-bottom: 0.5rem;
                }
                .progress-bar-container {
                    width: 100%;
                    height: 8px;
                    background: rgba(0,0,0,0.3);
                    border-radius: 1rem;
                    overflow: hidden;
                }
                .progress-bar {
                    height: 100%;
                    background: linear-gradient(90deg, var(--accent), var(--working));
                    border-radius: 1rem;
                    transition: width 0.5s ease;
                }

                .last-update {
                    margin-top: 1rem;
                    font-size: 0.75rem;
                    color: var(--text-dim);
                    text-align: right;
                }

                .empty-state {
                    text-align: center;
                    padding: 4rem 2rem;
                    background: var(--card-bg);
                    border-radius: 1rem;
                    border: 1px solid rgba(255, 255, 255, 0.05);
                }
                .empty-state .icon { font-size: 4rem; margin-bottom: 1rem; opacity: 0.3; }
                .empty-state h2 { color: var(--text-dim); margin-bottom: 0.5rem; }
                .empty-state p { color: var(--text-dim); font-size: 0.9rem; }

                .pulse-dot {
                    display: inline-block;
                    width: 8px;
                    height: 8px;
                    background: var(--success);
                    border-radius: 50%;
                    margin-right: 0.5rem;
                    animation: pulse 2s infinite;
                }
                @keyframes pulse {
                    0% { opacity: 1; transform: scale(1); }
                    50% { opacity: 0.5; transform: scale(1.2); }
                    100% { opacity: 1; transform: scale(1); }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <header>
                    <div class="logo-area">
                        <h1>🖥️ Worker Monitor</h1>
                        <p>Real-time scraping progress tracking</p>
                    </div>
                    <a href="http://localhost:3000/" class="back-btn">← Back to Dashboard</a>
                </header>

                <div class="stats-bar">
                    <div class="stat-box">
                        <h3>Active Workers</h3>
                        <div class="value" id="activeCount">0</div>
                    </div>
                    <div class="stat-box">
                        <h3>Total Progress</h3>
                        <div class="value" id="totalProgress">0%</div>
                    </div>
                    <div class="stat-box">
                        <h3>Products Scraped</h3>
                        <div class="value" id="productsScraped">0</div>
                    </div>
                </div>

                <div class="workers-grid" id="workersContainer">
                    <div class="empty-state">
                        <div class="icon">💤</div>
                        <h2>No Active Workers</h2>
                        <p>Start a worker from the dashboard to see real-time progress here.</p>
                    </div>
                </div>
            </div>

            <script>
                function formatTime(isoString) {
                    const date = new Date(isoString);
                    const now = new Date();
                    const diffMs = now - date;
                    const diffSec = Math.floor(diffMs / 1000);
                    
                    if (diffSec < 60) return \`\${diffSec}s ago\`;
                    if (diffSec < 3600) return \`\${Math.floor(diffSec / 60)}m ago\`;
                    return date.toLocaleTimeString();
                }

                async function updateWorkerStatus() {
                    try {
                        const response = await fetch('/worker-status');
                        const workers = await response.json();
                        
                        const workerIds = Object.keys(workers);
                        const container = document.getElementById('workersContainer');
                        
                        if (workerIds.length === 0) {
                            container.innerHTML = \`
                                <div class="empty-state">
                                    <div class="icon">💤</div>
                                    <h2>No Active Workers</h2>
                                    <p>Start a worker from the dashboard to see real-time progress here.</p>
                                </div>
                            \`;
                            document.getElementById('activeCount').textContent = '0';
                            document.getElementById('totalProgress').textContent = '0%';
                            document.getElementById('productsScraped').textContent = '0';
                            return;
                        }

                        // Update stats
                        document.getElementById('activeCount').textContent = workerIds.length;
                        
                        let totalProducts = 0;
                        let totalCurrent = 0;
                        workerIds.forEach(id => {
                            const w = workers[id];
                            totalProducts += w.totalProducts || 0;
                            totalCurrent += w.currentProduct || 0;
                        });
                        
                        const avgProgress = totalProducts > 0 ? Math.round((totalCurrent / totalProducts) * 100) : 0;
                        document.getElementById('totalProgress').textContent = avgProgress + '%';
                        document.getElementById('productsScraped').textContent = totalCurrent;

                        // Render worker cards
                        container.innerHTML = workerIds.map(workerId => {
                            const w = workers[workerId];
                            const progress = w.totalProducts > 0 ? Math.round((w.currentProduct / w.totalProducts) * 100) : 0;
                            const statusClass = w.status === 'completed' ? 'status-completed' : 
                                              w.status === 'idle' ? 'status-idle' : 'status-working';
                            
                            return \`
                                <div class="worker-card">
                                    <div class="worker-header">
                                        <div class="worker-id">
                                            <span class="pulse-dot"></span>
                                            \${workerId}
                                        </div>
                                        <div class="worker-status \${statusClass}">\${w.status}</div>
                                    </div>
                                    <div class="category-info">
                                        <div class="category-name">\${w.categoryName || 'Unknown Category'}</div>
                                        <div class="category-url">\${w.categoryUrl || ''}</div>
                                    </div>
                                    <div class="progress-section">
                                        <div class="progress-label">
                                            <span>Progress</span>
                                            <span><b>\${w.currentProduct || 0}</b> / \${w.totalProducts || 0} products</span>
                                        </div>
                                        <div class="progress-bar-container">
                                            <div class="progress-bar" style="width: \${progress}%"></div>
                                        </div>
                                    </div>
                                    <div class="last-update">Last update: \${formatTime(w.lastUpdate)}</div>
                                </div>
                            \`;
                        }).join('');
                        
                    } catch (err) {
                        console.error('Error fetching worker status:', err);
                    }
                }

                // Update every 2 seconds
                updateWorkerStatus();
                setInterval(updateWorkerStatus, 2000);
            </script>
        </body>
        </html>
    `);
});





// --- 🖼️ View Downloaded Images ---
app.get('/view-images', async (req, res) => {
    try {
        const IMAGES_DIR = path.join(__dirname, 'images');

        // Check if images directory exists
        const imagesDirExists = await fs.access(IMAGES_DIR).then(() => true).catch(() => false);

        if (!imagesDirExists) {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>No Images</title>
                    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
                    <style>
                        :root { --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); --accent: #38bdf8; --text: #f8fafc; --text-dim: #94a3b8; }
                        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background-image: radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%); }
                        .card { background: var(--card-bg); padding: 3rem; border-radius: 1.5rem; border: 1px solid rgba(255,255,255,0.1); text-align: center; max-width: 500px; backdrop-filter: blur(10px); }
                        h1 { color: var(--accent); margin-bottom: 1rem; }
                        p { color: var(--text-dim); margin-bottom: 2rem; }
                        .btn { display: inline-block; padding: 0.8rem 2rem; background: var(--accent); color: #000; text-decoration: none; border-radius: 0.75rem; font-weight: 700; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>🖼️ No Images Found</h1>
                        <p>The images folder doesn't exist. Download images first.</p>
                        <a href="http://localhost:3000/" class="btn">← Back to Dashboard</a>
                    </div>
                </body>
                </html>
            `);
        }

        // Read all category folders
        const categories = await fs.readdir(IMAGES_DIR);
        const categoryFolders = [];

        for (const category of categories) {
            const categoryPath = path.join(IMAGES_DIR, category);
            const stat = await fs.stat(categoryPath);

            if (stat.isDirectory()) {
                // Check if this folder directly contains images OR subfolders (medicines)
                const contents = await fs.readdir(categoryPath);

                const images = []; // Accumulate all images for this category

                for (const item of contents) {
                    const itemPath = path.join(categoryPath, item);
                    const itemStat = await fs.stat(itemPath);

                    if (itemStat.isDirectory()) {
                        // It's a medicine folder
                        const medicineImages = await fs.readdir(itemPath);
                        const validImages = medicineImages.filter(f => f.match(/\.(jpg|jpeg|png|gif|webp)$/i));

                        validImages.forEach(img => {
                            images.push({
                                name: item, // Use folder name as medicine name
                                filename: img,
                                path: `/images/${category}/${item}/${img}`
                            });
                        });
                    } else if (item.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
                        // Direct image in category folder
                        images.push({
                            name: item.replace(/\.(jpg|jpeg|png|gif|webp)$/i, ''),
                            filename: item,
                            path: `/images/${category}/${item}`
                        });
                    }
                }

                if (images.length > 0) {
                    categoryFolders.push({
                        name: category,
                        count: images.length,
                        images: images
                    });
                }
            }
        }

        if (categoryFolders.length === 0) {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>No Images</title>
                    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
                    <style>
                        :root { --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); --accent: #38bdf8; --text: #f8fafc; --text-dim: #94a3b8; }
                        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background-image: radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%); }
                        .card { background: var(--card-bg); padding: 3rem; border-radius: 1.5rem; border: 1px solid rgba(255,255,255,0.1); text-align: center; max-width: 500px; backdrop-filter: blur(10px); }
                        h1 { color: var(--accent); margin-bottom: 1rem; }
                        p { color: var(--text-dim); margin-bottom: 2rem; }
                        .btn { display: inline-block; padding: 0.8rem 2rem; background: var(--accent); color: #000; text-decoration: none; border-radius: 0.75rem; font-weight: 700; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>🖼️ No Images Downloaded</h1>
                        <p>No product images have been downloaded yet.</p>
                        <a href="http://localhost:3000/download-images" class="btn">📸 Download Images</a>
                        <a href="http://localhost:3000/" class="btn" style="background: rgba(255,255,255,0.1); margin-left: 10px;">← Dashboard</a>
                    </div>
                </body>
                </html>
            `);
        }

        // Calculate total images
        const totalImages = categoryFolders.reduce((sum, cat) => sum + cat.count, 0);

        // Send gallery HTML
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Image Gallery - Somacy</title>
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
                <style>
                    :root {
                        --bg: #0f172a;
                        --card-bg: rgba(30, 41, 59, 0.7);
                        --accent: #38bdf8;
                        --text: #f8fafc;
                        --text-dim: #94a3b8;
                        --success: #22c55e;
                    }
                    
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    
                    body {
                        font-family: 'Inter', sans-serif;
                        background: var(--bg);
                        color: var(--text);
                        padding: 20px;
                        background-image: radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%);
                        min-height: 100vh;
                    }
                    
                    .container {
                        max-width: 1400px;
                        margin: 0 auto;
                    }
                    
                    header {
                        background: var(--card-bg);
                        padding: 20px 30px;
                        border-radius: 12px;
                        border: 1px solid rgba(255,255,255,0.1);
                        backdrop-filter: blur(10px);
                        margin-bottom: 30px;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }
                    
                    h1 {
                        color: var(--accent);
                        font-size: 1.8rem;
                    }
                    
                    .stats {
                        display: flex;
                        gap: 20px;
                        margin-bottom: 30px;
                    }
                    
                    .stat-box {
                        background: var(--card-bg);
                        padding: 15px 25px;
                        border-radius: 8px;
                        border: 1px solid rgba(255,255,255,0.05);
                        backdrop-filter: blur(10px);
                    }
                    
                    .stat-box h3 {
                        font-size: 0.75rem;
                        color: var(--text-dim);
                        text-transform: uppercase;
                        margin-bottom: 5px;
                    }
                    
                    .stat-box .value {
                        font-size: 1.8rem;
                        font-weight: 700;
                        color: var(--accent);
                    }
                    
                    .filters {
                        background: var(--card-bg);
                        padding: 20px;
                        border-radius: 12px;
                        border: 1px solid rgba(255,255,255,0.1);
                        backdrop-filter: blur(10px);
                        margin-bottom: 30px;
                        display: flex;
                        gap: 15px;
                        align-items: center;
                    }
                    
                    .filters label {
                        color: var(--text-dim);
                        font-size: 0.9rem;
                        font-weight: 600;
                    }
                    
                    .filters select,
                    .filters input {
                        padding: 10px 15px;
                        background: rgba(0,0,0,0.3);
                        border: 1px solid rgba(255,255,255,0.1);
                        border-radius: 8px;
                        color: var(--text);
                        font-family: 'Inter', sans-serif;
                        font-size: 0.9rem;
                    }
                    
                    .filters select {
                        min-width: 200px;
                        cursor: pointer;
                    }
                    
                    .filters input {
                        flex: 1;
                        max-width: 300px;
                    }
                    
                    .category-section {
                        margin-bottom: 40px;
                    }
                    
                    .category-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 20px;
                        padding: 15px 20px;
                        background: var(--card-bg);
                        border-radius: 8px;
                        border: 1px solid rgba(255,255,255,0.05);
                        backdrop-filter: blur(10px);
                    }
                    
                    .category-header h2 {
                        color: var(--text);
                        font-size: 1.3rem;
                    }
                    
                    .category-header .count {
                        color: var(--text-dim);
                        font-size: 0.9rem;
                    }
                    
                    .gallery {
                        display: grid;
                        grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
                        gap: 20px;
                    }
                    
                    .image-card {
                        background: var(--card-bg);
                        border-radius: 12px;
                        border: 1px solid rgba(255,255,255,0.05);
                        overflow: hidden;
                        transition: all 0.3s;
                        cursor: pointer;
                        backdrop-filter: blur(10px);
                    }
                    
                    .image-card:hover {
                        transform: translateY(-5px);
                        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                        border-color: var(--accent);
                    }
                    
                    .image-wrapper {
                        width: 100%;
                        height: 250px;
                        background: rgba(0,0,0,0.3);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        overflow: hidden;
                    }
                    
                    .image-wrapper img {
                        max-width: 100%;
                        max-height: 100%;
                        object-fit: contain;
                    }
                    
                    .image-info {
                        padding: 15px;
                    }
                    
                    .image-name {
                        color: var(--text);
                        font-size: 0.9rem;
                        font-weight: 600;
                        margin-bottom: 5px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                    }
                    
                    .image-filename {
                        color: var(--text-dim);
                        font-size: 0.75rem;
                        font-family: monospace;
                    }
                    
                    .back-btn {
                        padding: 10px 20px;
                        background: rgba(255,255,255,0.05);
                        color: var(--text);
                        text-decoration: none;
                        border-radius: 8px;
                        border: 1px solid rgba(255,255,255,0.1);
                        font-weight: 600;
                        transition: all 0.3s;
                    }
                    
                    .back-btn:hover {
                        background: rgba(255,255,255,0.1);
                    }
                    
                    .no-results {
                        text-align: center;
                        padding: 60px 20px;
                        color: var(--text-dim);
                        font-size: 1.1rem;
                    }
                    
                    /* Modal */
                    .modal {
                        display: none;
                        position: fixed;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        background: rgba(0,0,0,0.9);
                        z-index: 1000;
                        align-items: center;
                        justify-content: center;
                    }
                    
                    .modal.active {
                        display: flex;
                    }
                    
                    .modal-content {
                        max-width: 90%;
                        max-height: 90%;
                        position: relative;
                    }
                    
                    .modal-content img {
                        max-width: 100%;
                        max-height: 90vh;
                        object-fit: contain;
                    }
                    
                    .modal-close {
                        position: absolute;
                        top: 20px;
                        right: 20px;
                        background: var(--accent);
                        color: #000;
                        border: none;
                        padding: 10px 20px;
                        border-radius: 8px;
                        font-weight: 700;
                        cursor: pointer;
                        font-size: 1rem;
                    }
                    
                    .modal-info {
                        position: absolute;
                        bottom: 20px;
                        left: 20px;
                        background: var(--card-bg);
                        padding: 15px 20px;
                        border-radius: 8px;
                        backdrop-filter: blur(10px);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <header>
                        <h1>🖼️ Image Gallery</h1>
                        <a href="http://localhost:3000/" class="back-btn">← Back to Dashboard</a>
                    </header>
                    
                    <div class="stats">
                        <div class="stat-box">
                            <h3>Total Categories</h3>
                            <div class="value">${categoryFolders.length}</div>
                        </div>
                        <div class="stat-box">
                            <h3>Total Images</h3>
                            <div class="value">${totalImages}</div>
                        </div>
                    </div>
                    
                    <div class="filters">
                        <label>Category:</label>
                        <select id="categoryFilter">
                            <option value="all">All Categories</option>
                            ${categoryFolders.map(cat => `<option value="${cat.name}">${cat.name} (${cat.count})</option>`).join('')}
                        </select>
                        
                        <label>Search:</label>
                        <input type="text" id="searchInput" placeholder="Search by medicine name...">
                    </div>
                    
                    <div id="gallery-container">
                        ${categoryFolders.map(category => `
                            <div class="category-section" data-category="${category.name}">
                                <div class="category-header">
                                    <h2>${category.name}</h2>
                                    <span class="count">${category.count} images</span>
                                </div>
                                <div class="gallery">
                                    ${category.images.map(img => `
                                        <div class="image-card" data-name="${img.name.toLowerCase()}" onclick="openModal('${img.path}', '${img.name}', '${category.name}')">
                                            <div class="image-wrapper">
                                                <img src="${img.path}" alt="${img.name}" loading="lazy">
                                            </div>
                                            <div class="image-info">
                                                <div class="image-name" title="${img.name}">${img.name}</div>
                                                <div class="image-filename">${img.filename}</div>
                                            </div>
                                        </div>
                                    `).join('')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                    
                    <div id="no-results" class="no-results" style="display: none;">
                        No images found matching your filters.
                    </div>
                </div>
                
                <!-- Modal -->
                <div id="modal" class="modal" onclick="closeModal()">
                    <button class="modal-close" onclick="closeModal()">✕ Close</button>
                    <div class="modal-content" onclick="event.stopPropagation()">
                        <img id="modal-image" src="" alt="">
                        <div class="modal-info">
                            <div id="modal-name" style="font-weight: 600; margin-bottom: 5px;"></div>
                            <div id="modal-category" style="color: var(--text-dim); font-size: 0.9rem;"></div>
                        </div>
                    </div>
                </div>
                
                <script>
                    const categoryFilter = document.getElementById('categoryFilter');
                    const searchInput = document.getElementById('searchInput');
                    const categorySections = document.querySelectorAll('.category-section');
                    const noResults = document.getElementById('no-results');
                    
                    function filterGallery() {
                        const selectedCategory = categoryFilter.value;
                        const searchTerm = searchInput.value.toLowerCase();
                        let hasResults = false;
                        
                        categorySections.forEach(section => {
                            const categoryName = section.dataset.category;
                            const categoryMatch = selectedCategory === 'all' || categoryName === selectedCategory;
                            
                            if (!categoryMatch) {
                                section.style.display = 'none';
                                return;
                            }
                            
                            const imageCards = section.querySelectorAll('.image-card');
                            let categoryHasResults = false;
                            
                            imageCards.forEach(card => {
                                const imageName = card.dataset.name;
                                const nameMatch = imageName.includes(searchTerm);
                                
                                if (nameMatch) {
                                    card.style.display = 'block';
                                    categoryHasResults = true;
                                    hasResults = true;
                                } else {
                                    card.style.display = 'none';
                                }
                            });
                            
                            section.style.display = categoryHasResults ? 'block' : 'none';
                        });
                        
                        noResults.style.display = hasResults ? 'none' : 'block';
                    }
                    
                    categoryFilter.addEventListener('change', filterGallery);
                    searchInput.addEventListener('input', filterGallery);
                    
                    function openModal(imagePath, imageName, categoryName) {
                        const modal = document.getElementById('modal');
                        const modalImage = document.getElementById('modal-image');
                        const modalName = document.getElementById('modal-name');
                        const modalCategory = document.getElementById('modal-category');
                        
                        modalImage.src = imagePath;
                        modalName.textContent = imageName;
                        modalCategory.textContent = 'Category: ' + categoryName;
                        modal.classList.add('active');
                    }
                    
                    function closeModal() {
                        const modal = document.getElementById('modal');
                        modal.classList.remove('active');
                    }
                    
                    // Close modal on Escape key
                    document.addEventListener('keydown', (e) => {
                        if (e.key === 'Escape') closeModal();
                    });
                </script>
            </body>
            </html>
        `);

    } catch (err) {
        console.error('❌ View images error:', err.message);
        res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
});


async function init() {
    await loadJobs();
    if (jobs.length === 0) {
        await scrapeMasterCategories();
    }
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Orchestrator Server running on http://localhost:${PORT}`);
        console.log(`📡 Tip: Access from other PCs using http://YOUR_PC_IP:${PORT}`);
    });

    // Pulse to show server is alive
    setInterval(() => {
        const timestamp = new Date().toLocaleTimeString();
        // Silent pulse, or we could log it. Let's not clutter.
    }, 60000);
}

init();








