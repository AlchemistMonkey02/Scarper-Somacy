# Step-by-Step Guide: Running the Distributed Scraper

This guide will show you how to set up one **Manager PC** (the Server) and multiple **Scraper PCs** (the Workers).

---

## Phase 1: Setting up the Manager (Server PC)
*This is the PC that will collect all the data and manage the list of tasks.*

1.  **Open PowerShell or Terminal** on the PC you want to use as the server.
2.  **Navigate to your project folder**:
    ```powershell
    cd C:\Users\DELL\Desktop\somacy
    ```
3.  **Install dependencies** (if not already done):
    ```bash
    npm install express puppeteer axios body-parser
    ```
4.  **Find your PC's IP Address**:
    *   Type `ipconfig` in the terminal.
    *   Look for **IPv4 Address** under your active connection (Wi-Fi or Ethernet).
    *   *Example: 192.168.1.10* (Write this down!)
5.  **Start the Server**:
    ```bash
    node server.js
    ```
    *   *Wait until you see "Discovered 152 total categories" and "Server running on port 3000".*

---

## Phase 2: Setting up the Scrapers (Worker PCs)
*Perform these steps on EVERY OTHER PC you want to use for scraping.*

1.  **Copy the Files**: Copy only `worker.js` and `package.json` to the other PCs.
2.  **Edit the Configuration**:
    *   Open `worker.js` on the Worker PC.
    *   Find **Line 7**: `const SERVER_URL = 'http://localhost:3000';`
    *   Change `localhost` to the **IP Address** you wrote down in Phase 1.
    *   *Example:* `const SERVER_URL = 'http://192.168.1.10:3000';`
3.  **Install Dependencies** on the Worker PC:
    ```bash
    npm install puppeteer axios
    ```
4.  **Set Scraping Limits (Optional)**:
    - If you want a PC to stop after a certain number of categories (e.g., 10), open `worker.js` and set:
      ```javascript
      const TOTAL_LIMIT = 10;
      ```
    - If you want it to keep going until the end, leave it as:
      ```javascript
      const TOTAL_LIMIT = 0;
      ```
5.  **Start Scraping**:
    ```bash
    node worker.js
    ```

---

## Phase 3: Monitoring Progress

-   **On the Server Console**: You will see messages like `[Category Name] Saved results` as workers finish their work.
-   **In the `data/` folder**: All the JSON files will be saved **on the Server PC**, regardless of which worker did the scraping.
-   **Check Status**: You can open a browser on any PC and go to `http://[SERVER-IP]:3000/status` to see how many categories are left.

---

## 🕹️ Control Center: The Dashboard

The easiest way to manage your scrape is through the **Visual Dashboard**. It shows you live stats and lets you download data with one click.

- **Open Dashboard**: `http://localhost:3000/`

---

## How to Fix Stuck or Failed Jobs

If a worker crashes or you stop it manually, some categories might stay stuck as `in_progress`. You can fix these by opening these links in your browser on the **Server PC**:

1.  **Reset Stuck Jobs**: `http://localhost:3000/reset-stuck`
    - This will find any job that has been "Working" for more than 30 minutes and reset it to "Pending" so another worker can try again.
2.  **Reset ALL Failed/Working Jobs**: `http://localhost:3000/reset-all`
    - **Use this if you stop all workers and want to restart everything that isn't finished.** It converts all `failed` and `in_progress` jobs back to `pending`.
3.  **Retry Only Failed Jobs**: `http://localhost:3000/retry-failed`
    - This resets only the jobs marked as `failed`, resets their try-count, and automatically starts a new worker to process them.

---

## Pushing Data to External API

You can now send your scraped data to another server (API) using these endpoints:

1.  **Push ALL Completed Data**: `http://localhost:3000/push-all`
    - This will loop through every category you have finished and send it to the external API.
2.  **Push a SINGLE Category**: `http://localhost:3000/push-category?name=category_name`
    - Example: `http://localhost:3000/push-category?name=vitamins`

> [!NOTE]
> Make sure to open `server.js` and update the `EXTERNAL_API_URL` variable at the top with your real API address!

---

## Exporting Data to Excel

You can download all your collected data in a single, clean Excel file at any time.

1.  **Download Excel**: `http://localhost:3000/get-excel`
    - This endpoint scans your `data/` folder, combines all the JSON files, and sends you an `.xlsx` file for download.
    - **Bonus**: It includes a column called "Local Image Path" which tells you exactly where the photos are stored on your PC.

---

## Downloading Images

You can download all the medicine photos to your local PC and organize them into neat folders.

1.  **Start Download**: `http://localhost:3000/download-images`
    - This will loop through every finished category.
    - It creates folders like this: `images/[Category]/[Medicine Name]/photo1.jpg`.
    - You can watch the progress in your browser as it downloads.

---

## Starting Workers from Browser (with Proxy)

You can now trigger a new worker process directly from your browser! This is useful if you want to quickly start a scrape using a specific VPN or Proxy setting on the Server PC.

1.  **Start a normal worker**: 
    Go to: `http://localhost:3000/start-worker`
2.  **Start a worker WITH a Proxy**:
    Go to: `http://localhost:3000/start-worker?proxy=http://your-proxy-address:port`
3.  **Start a worker WITH a Limit**:
    Go to: `http://localhost:3000/start-worker?limit=20`
4.  **Start a worker WITH BOTH**:
    Go to: `http://localhost:3000/start-worker?proxy=http://your-proxy-address:port&limit=10`

---

## Troubleshooting

### 1. Worker can't connect to Server?
-   **Firewall**: The most common issue. On the **Server PC**, you may need to allow Port 3000 through the Windows Firewall.
    -   Go to *Windows Settings > Update & Security > Windows Security > Firewall & network protection > Allow an app through firewall*.
-   **Same Network**: Make sure all PCs are connected to the same Wi-Fi or Router.

### 2. Can I run a worker on the Server PC?
-   **Yes!** Just leave `SERVER_URL` as `http://localhost:3000` on the server PC and run `node worker.js` in a second terminal window.

### 3. What if a PC crashes?
-   If a worker PC crashes, the server will notice the job isn't finished.
-   If the server crashes, just restart it. It will read `jobs.json` and resume exactly where it left off.
