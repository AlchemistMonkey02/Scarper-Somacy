# 🏥 Netmeds Distributed Scraper: Complete System Guide

This guide explains how to host the server online, set up workers on multiple PCs, and use all the system's features.

---

## 🏗️ Folder and File Structure

To host this system, you need the following setup:

### For the Main PC (The Boss / Server)
You need these files and folders:
1.  **`server.js`**: The main orchestrator.
2.  **`package.json`**: Lists all required libraries.
3.  **`jobs.json`**: Current status of all 152 categories.
4.  **`data/`** (Folder): Where all scraped JSON files are saved.
5.  **`images/`** (Folder): Where all downloaded photos are saved.

### For the Scraper PCs (The Workers)
You only need these files:
1.  **`worker.js`**: The script that runs the browser.
2.  **`package.json`**: To install dependencies.

---

## 🌐 Hosting Online (Shared Workflow)

1.  **Set up the Server**:
    *   Place `server.js` and `package.json` on your hosting PC (VPS or Main PC).
    *   Run `npm install`.
    *   Start the server: `node server.js`.
    *   **Crucial**: If hosting on a cloud VPS, ensure **Port 3000** is open in the firewall.

2.  **Configure Workers**:
    *   On every other PC, open `worker.js`.
    *   Change `SERVER_URL` to your Server's Public IP or Local IP.
        ```javascript
        const SERVER_URL = 'http://YOUR_SERVER_IP:3000';
        ```
    *   Run `npm install` and then `node worker.js`.

---

## 🔗 Endpoint Reference (Browser Controls)

Open these URLs in your browser (on the Server PC use `localhost`, on other PCs use the `Server-IP`):

### �️ The Dashboard (Recommended)
- **`http://localhost:3000/`**
  - **Purpose**: The main control hub. See live stats, status of every category, and access all actions (Excel, Images, Workers) from one beautiful interface.

---

### �📊 Management & Monitoring
- **`http://localhost:3000/status`**
  - **Purpose**: See the real-time count of Pending, Working, and Finished categories.
- **`http://localhost:3000/reset-stuck`**
  - **Purpose**: Fix categories that got "frozen" because a worker PC crashed or was closed.
- **`http://localhost:3000/reset-all`**
  - **Purpose**: Wipe the status of all `failed` and `working` jobs so you can restart the whole process.
- **`http://localhost:3000/start-worker`**
  - **Purpose**: Start a worker script immediately on the Server machine.
  - **With Proxy**: `.../start-worker?proxy=http://IP:PORT`
  - **With Limit**: `.../start-worker?limit=20` (Processes only 20 categories)

### 📥 Data & Image Extraction
- **`http://localhost:3000/get-excel`**
  - **Purpose**: Merges **ALL** scraped data into one clean `.xlsx` file. It includes a column for local image paths.
- **`http://localhost:3000/download-images`**
  - **Purpose**: Downloads all medicine photos to the `images/` folder and organizes them by category.
- **`http://localhost:3000/retry-failed`**
  - **Purpose**: Resets only the categories that failed 3 times and starts a fresh worker to try them again.

### 📤 External API Integration
- **`http://localhost:3000/push-all`**
  - **Purpose**: Sends every single record from your `data/` folder to your other API, **one by one**.
- **`http://localhost:3000/push-category?name=category_name`**
  - **Purpose**: Sends records for only one specific category.

---

## 💡 Pro-Tips for Workers
- **VPN usage**: Simply turn on your VPN on the Worker PC and start `node worker.js`. No extra code needed.
- **Total Limit**: If you want "PC A" to only do 20 categories and then stop, set `const TOTAL_LIMIT = 20;` at the top of its `worker.js`.
- **Parallel Speed**: You can increase `CONCURRENT_PRODUCTS_PER_BROWSER` in `worker.js` if the PC is very powerful (e.g., set to 15 or 20).
