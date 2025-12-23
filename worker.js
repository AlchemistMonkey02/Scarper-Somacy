const puppeteer = require('puppeteer');
const axios = require('axios');
const path = require('path');
const OS = require('os');

// --- CONFIGURATION ---
const SERVER_URL = 'http://localhost:3000'; // Change to Server IP if running on other PC
const WORKER_ID = `worker_${OS.hostname()}_${Date.now()}`;

// How many categories this PC should grab at one time
const BATCH_SIZE = 5;

// TOTAL categories this PC should do before stopping (0 for unlimited)
// Example: If you set this to 10, this PC will stop after scraping 10 categories.
const TOTAL_LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT) : 0;

// Parallel tabs for detail scraping
const CONCURRENT_PRODUCTS_PER_BROWSER = 10;

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to report progress to server
async function reportProgress(categoryName, categoryUrl, status, currentProduct, totalProducts) {
    try {
        const progress = totalProducts > 0 ? Math.round((currentProduct / totalProducts) * 100) : 0;
        await axios.post(`${SERVER_URL}/report-progress`, {
            workerId: WORKER_ID,
            categoryName,
            categoryUrl,
            status,
            currentProduct,
            totalProducts,
            progress
        });
    } catch (err) {
        // Silent fail - don't let progress reporting break the scraper
    }
}

const pdpScrapeLogic = async () => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim() || null;
    const getInnerText = (selector) => clean(document.querySelector(selector)?.innerText);
    const getFullText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.innerText.trim() : null;
    };
    const getList = (selector) => Array.from(document.querySelectorAll(selector)).map(el => clean(el.innerText)).filter(Boolean);

    const extractComposition = () => {
        const link = document.querySelector('a[href*="contains="]');
        if (link && link.href) {
            try {
                const u = new URL(link.href, 'https://www.netmeds.com');
                const c = u.searchParams.get('contains');
                if (c) return decodeURIComponent(c.replace(/\+/g, ' '));
            } catch { }
        }
        const intro = document.querySelector('.prescript-txt')?.innerText || '';
        const match = intro.match(/contains a medicine called ([^.]+)/i);
        if (match) return clean(match[1]);
        const rows = Array.from(document.querySelectorAll('table tr'));
        for (const row of rows) {
            const cells = row.querySelectorAll('td, th');
            if (cells.length >= 2) {
                const label = (cells[0]?.innerText || '').toLowerCase();
                if (label.includes('composition') || label.includes('active ingredient')) return clean(cells[1]?.innerText || cells[2]?.innerText);
            }
        }
        return null;
    };

    const introduction = getFullText('#np_tab1 .inner-content');
    const usesList = getList('#np_tab3 li');
    const usesDetails = getFullText('#np_tab3 .inner-content');
    const mechanismOfAction = getFullText('#np_tab6 .inner-content');
    const usageList = getList('#np_tab7 li');
    const usageDetails = getFullText('#np_tab7 .inner-content');
    const sideEffectsList = getList('#np_tab10 li, #np_tab4 li');
    const sideEffectsDetails = getFullText('#np_tab10 .inner-content') || getFullText('#np_tab4 .inner-content');

    const warnings = Array.from(document.querySelectorAll('#np_tab12 .manage-content')).map(el => ({
        category: clean(el.querySelector('.manage-leftcontent h3')?.innerText),
        status: clean(el.querySelector('.manage-leftcontent span')?.innerText),
        details: clean(el.querySelector('.manage-rightcontent p')?.innerText)
    }));
    const otherWarningsText = getFullText('#np_tab12_12 .inner-content');
    if (otherWarningsText) warnings.push({ category: "Others", status: "Warning", details: otherWarningsText });
    const warningsRaw = (getFullText('#np_tab12') || '') + (otherWarningsText ? '\n' + otherWarningsText : '');

    const interactions = getFullText('#np_tab18 .inner-content');

    const synopsis = {};
    document.querySelectorAll('#np_tab21 table tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
            const key = clean(cells[0].innerText).replace(/:$/, '');
            const val = clean(cells[2].innerText);
            if (key && val) synopsis[key] = val;
        }
    });

    const moreInfo = getFullText('#np_tab22 .inner-content');
    const references = getList('#np_tab25 p, #np_tab25 li');

    const faqs = [];
    const faqContainer = document.querySelector('#np_tab24 .inner-content');
    if (faqContainer) {
        const faqElems = Array.from(faqContainer.children);
        let currentQ = null, currentA = [];
        faqElems.forEach(el => {
            const text = clean(el.innerText);
            if (el.tagName === 'H2' && (text.startsWith('Q:') || text.includes('?'))) {
                if (currentQ) faqs.push({ question: currentQ, answer: currentA.join(' ').trim() });
                currentQ = text; currentA = [];
            } else if (currentQ && ['P', 'UL', 'OL', 'LI', 'DIV'].includes(el.tagName)) currentA.push(text);
        });
        if (currentQ) faqs.push({ question: currentQ, answer: currentA.join(' ').trim() });
    }

    const author = clean(document.querySelector('.authorName')?.innerText || document.querySelector('#np_tab28 .authorName')?.innerText);
    const lastUpdated = document.querySelector('.upDated') ? clean(document.querySelector('.upDated').innerText.replace(/Last updated on\s*/i, '')) : null;
    const categoryChain = Array.from(document.querySelectorAll('.canget .label, .breadcrumb .breadcrumb-item')).map(el => clean(el.innerText)).filter(Boolean);
    const images = Array.from(document.querySelectorAll('.image-gallery-box__list img, .pdp-image')).map(img => img.getAttribute('src') || img.src).filter(src => src && src.startsWith('http'));

    return {
        introduction, uses: usesList, usesDetails, mechanismOfAction, usageInstructions: usageList, usageDetails,
        sideEffects: sideEffectsList, sideEffectsDetails, warnings, warningsRaw, interactions, synopsis, moreInfo,
        faqs, references, author, lastUpdated, categoryChain, composition: extractComposition(), images
    };
};

async function autoScroll(page) {
    let previousHeight = 0;
    let noChangeCount = 0;
    const startTime = Date.now();
    const maxTime = 4 * 60 * 1000;

    while (Date.now() - startTime < maxTime) {
        try {
            const scrollHeight = await page.evaluate(() => {
                window.scrollBy(0, window.innerHeight * 2);
                return document.body.scrollHeight;
            });

            if (scrollHeight === previousHeight) {
                if (++noChangeCount >= 4) break;
            } else {
                noChangeCount = 0;
                previousHeight = scrollHeight;
            }
            await delay(1500);
        } catch (e) { break; }
    }
}

// Helper to load partial data for resume
async function loadPartialData(categoryUrl) {
    try {
        const response = await axios.get(`${SERVER_URL}/get-partial-data`, {
            params: { categoryUrl }
        });

        if (response.data.exists) {
            console.log(`   📥 Found partial data: ${response.data.data.length} products already scraped`);
            return response.data.data;
        }
    } catch (err) {
        console.log(`   ℹ️ No partial data found, starting fresh`);
    }
    return [];
}

async function scrapeCategory(category) {
    console.log(`🚀 [${category.name}] Starting Scraping...`);

    // Load partial data if exists (for resume)
    const partialData = await loadPartialData(category.url);
    const scrapedUrls = new Set(partialData.map(p => p.url));

    // Report start
    await reportProgress(category.name, category.url, 'starting', partialData.length, 0);

    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
    if (process.env.PROXY_URL) {
        launchArgs.push(`--proxy-server=${process.env.PROXY_URL}`);
        console.log(`🛠️ Using Proxy: ${process.env.PROXY_URL}`);
    }

    const browser = await puppeteer.launch({
        headless: true,
        args: launchArgs
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(category.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await autoScroll(page);

        const products = await page.$$eval('.product-card-container, a[href^="/product/"]', (elements) => {
            const unique = new Map();
            elements.forEach(el => {
                const link = el.tagName === 'A' ? el : el.querySelector('a[href^="/product/"]');
                if (!link) return;
                const href = link.getAttribute('href');
                if (!href) return;
                const url = href.startsWith('http') ? href : 'https://www.netmeds.com' + href;
                if (unique.has(url)) return;

                const card = el.classList.contains('product-card-container') ? el : el.closest('.product-card-container');
                const clean = (s) => (s || '').replace(/\s+/g, ' ').trim() || null;
                unique.set(url, {
                    url,
                    name: clean(card?.querySelector('.product-desc h3')?.innerText || card?.querySelector('h3')?.innerText || link.getAttribute('title')),
                    brand: clean(card?.querySelector('.regular-xxxs')?.innerText?.replace(/^By\s+/i, '') || card?.querySelector('.drug-manufac')?.innerText),
                    packInfo: clean(card?.querySelector('.jm-body-xxxs')?.innerText || card?.querySelector('.drug-varients')?.innerText),
                    isPrescriptionRequired: !!card?.querySelector('img[alt*="prescription required"]'),
                    price: {
                        bestPrice: clean(card?.querySelector('.best-price-value')?.innerText || card?.querySelector('.ess-price')?.innerText),
                        mrp: clean(card?.querySelector('.mrp .strick')?.innerText || card?.querySelector('.strike-price')?.innerText),
                        discountedPrice: clean(card?.querySelector('.priceDisplay')?.innerText || card?.querySelector('.price')?.innerText)
                    }
                });
            });
            return Array.from(unique.values());
        });

        // Filter out already-scraped products (for resume)
        const productsToScrape = products.filter(p => !scrapedUrls.has(p.url));

        if (scrapedUrls.size > 0) {
            console.log(`   ℹ️ Total products: ${products.length}, Already scraped: ${scrapedUrls.size}, To scrape: ${productsToScrape.length}`);
        } else {
            console.log(`   ℹ️ Found ${products.length} products to scrape`);
        }

        // Report total products found
        await reportProgress(category.name, category.url, 'working', partialData.length, products.length);

        const results = [...partialData]; // Start with existing data
        for (let i = 0; i < productsToScrape.length; i += CONCURRENT_PRODUCTS_PER_BROWSER) {
            const batch = productsToScrape.slice(i, i + CONCURRENT_PRODUCTS_PER_BROWSER);
            const batchPromises = batch.map(async (prod) => {
                let pdpPage;
                try {
                    pdpPage = await browser.newPage();
                    await pdpPage.setRequestInterception(true);
                    pdpPage.on('request', (r) => (['image', 'font', 'media'].includes(r.resourceType()) ? r.abort() : r.continue()));

                    await pdpPage.goto(prod.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    const details = await pdpPage.evaluate(pdpScrapeLogic);
                    return { ...prod, ...details };
                } catch (err) {
                    return prod;
                } finally {
                    if (pdpPage) await pdpPage.close();
                }
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
            console.log(`   ✅ [${category.name}] Scraped ${results.length}/${products.length}`);

            // Report progress after each batch
            await reportProgress(category.name, category.url, 'working', results.length, products.length);

            // Save partial progress after each batch
            await axios.post(`${SERVER_URL}/report-partial`, {
                categoryUrl: category.url,
                data: results,
                isComplete: false
            });

            await delay(500);
        }

        // Final save with completion flag
        await axios.post(`${SERVER_URL}/report-partial`, {
            categoryUrl: category.url,
            data: results,
            isComplete: true
        });
        console.log(`💾 [${category.name}] Results reported to server.`);

        // Report completion
        await reportProgress(category.name, category.url, 'completed', results.length, results.length);

    } catch (err) {
        console.error(`❌ [${category.name}] Error: ${err.message}`);
        await axios.post(`${SERVER_URL}/report-failure`, {
            categoryUrl: category.url,
            error: err.message
        });
    } finally {
        if (browser) await browser.close();
    }
}

async function runWorker() {
    console.log(`👷 Worker ${WORKER_ID} starting...`);
    let totalScrapedByThisWorker = 0;

    const MAX_RUN_TIME = 2 * 60 * 60 * 1000; // 2 Hours
    const REST_PERIOD = 30 * 60 * 1000;      // 30 Minutes
    let workerStartTime = Date.now();

    while (true) {
        if (TOTAL_LIMIT > 0 && totalScrapedByThisWorker >= TOTAL_LIMIT) {
            console.log(`🏁 Reached total limit of ${TOTAL_LIMIT} categories. Stopping.`);
            break;
        }

        try {
            const currentRequestedSize = TOTAL_LIMIT > 0
                ? Math.min(BATCH_SIZE, TOTAL_LIMIT - totalScrapedByThisWorker)
                : BATCH_SIZE;

            const response = await axios.get(`${SERVER_URL}/get-batch`, {
                params: { workerId: WORKER_ID, size: currentRequestedSize }
            });

            const batch = response.data;
            if (batch.length === 0) {
                console.log('😴 No more jobs. Waiting 30s...');
                await delay(30000);
                continue;
            }

            console.log(`📦 Got batch of ${batch.length} categories.`);
            for (const category of batch) {
                // --- 🛑 TIMEOUT CHECK ---
                if (Date.now() - workerStartTime > MAX_RUN_TIME) {
                    console.log(`⏰ Worker has been running for > 2 hours. Taking a 30-minute break...`);
                    await delay(REST_PERIOD);
                    console.log(`🌅 30 minutes over. Resuming work...`);
                    workerStartTime = Date.now(); // Reset timer
                }

                await scrapeCategory(category);
                totalScrapedByThisWorker++;

                if (TOTAL_LIMIT > 0 && totalScrapedByThisWorker >= TOTAL_LIMIT) {
                    console.log(`🏁 Reached total limit of ${TOTAL_LIMIT} categories. Stopping.`);
                    return;
                }
            }
        } catch (err) {
            console.error('❌ Worker Error (polling):', err.message);
            await delay(10000);
        }
    }
}

runWorker();

