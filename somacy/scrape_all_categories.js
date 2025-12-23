
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

(async () => {
    const browser = await puppeteer.launch({
        headless: true,
        protocolTimeout: 300000, // 5 minutes
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Helps prevents crash on large pages
            '--disable-accelerated-2d-canvas',
            '--disable-gpu'
        ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    // ensure data directory exists
    const dataDir = path.join(__dirname, 'data');
    try {
        await fs.mkdir(dataDir, { recursive: true });
    } catch (err) { }

    const masterUrl = 'https://www.netmeds.com/collection/all-medicines';
    console.log(`🔍 Navigating to Master Page: ${masterUrl} `);

    try {
        await page.goto(masterUrl, { waitUntil: 'networkidle2', timeout: 90000 });

        // Click "Show More" if present to load all categories (Optimized XPath)
        try {
            const clicked = await page.evaluate(() => {
                const result = document.evaluate(
                    "//div[contains(text(), 'more')]",
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                );
                const btn = result.singleNodeValue;
                if (btn && /\+\s*\d+\s*more/i.test(btn.innerText)) {
                    btn.click();
                    return true;
                }
                return false;
            });

            if (clicked) {
                console.log("Found expansion button. Clicking...");
                await new Promise(r => setTimeout(r, 10000)); // Wait for expansion
            }
        } catch (e) {
            console.log("Error checking for 'Show More' button:", e.message);
        }

        // Extract all category links
        const categories = await page.$$eval('a[href*="categorynamelevel2="]', links => {
            return links.map(link => ({
                name: link.innerText.trim(),
                url: link.href
            }));
        });

        if (categories.length < 20) {
            console.log("⚠️ Warning: Low category count found. Dumping all links in filter section for debugging...");
            // Debug: find the filter container and list all links
            const allLinks = await page.evaluate(() => {
                const filterDiv = document.querySelector('.filter-product');
                return filterDiv ? Array.from(filterDiv.querySelectorAll('a')).map(a => a.href) : [];
            });
            console.log("First 10 links in filter section:", allLinks.slice(0, 10));
        }

        console.log(`📦 Found ${categories.length} categories.`);

        for (let i = 0; i < categories.length; i++) {
            const category = categories[i];
            console.log(`\n🚀 Starting Category ${i + 1}/${categories.length}: ${category.name}`);

            // Generate filename based on category name
            const safeName = category.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const fileName = path.join(dataDir, `${safeName}.json`);

            // Skip if already exists (resume capability)
            try {
                await fs.access(fileName);
                console.log(`⏩ Skipping ${category.name} (File exists)`);
                continue;
            } catch { }

            page = await scrapeCategory(browser, page, category.url, fileName);

            // LONG DELAY between categories as requested
            console.log('⏳ Waiting 10 seconds before next category...');
            await new Promise(r => setTimeout(r, 10000));
        }

    } catch (err) {
        console.error('❌ Master Page Error:', err);
    } finally {
        await browser.close();
    }
})();

async function scrapeCategory(browser, page, collectionUrl, outputFile) {
    // Enable Request Interception to save memory (Block images/fonts)
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    console.log(`🔍 Navigating to Category: ${collectionUrl}`);
    // Navigate and Scroll
    try {
        await page.goto(collectionUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await autoScroll(page);
    } catch (e) {
        console.log(`⚠️ Warning: Navigation/Scroll issue for ${collectionUrl}: ${e.message}`);
    }

    // Extract Basic Data (PLP)
    let medicinesList = [];
    try {
        medicinesList = await page.$$eval('a[href^="/product/"]', links => {
            const uniqueItems = [];
            const seenUrls = new Set();
            links.forEach(link => {
                const href = link.getAttribute('href').trim();
                const url = 'https://www.netmeds.com' + href;
                // Check if img tag exists (even if not loaded)
                const hasImage = !!link.querySelector('img');

                if (seenUrls.has(url)) return;
                if (!hasImage) return;

                seenUrls.add(url);
                const card = link.parentElement;
                const clean = (s) => (s || '').replace(/\s+/g, ' ').trim() || null;
                const name = clean(card.querySelector('.product-desc h3')?.innerText || card.querySelector('h3')?.innerText || link.getAttribute('title'));
                const brand = clean(card.querySelector('.regular-xxxs')?.innerText?.replace(/^By\s+/i, '') || card.querySelector('.drug-manufac')?.innerText);
                const packInfo = clean(card.querySelector('.jm-body-xxxs')?.innerText || card.querySelector('.drug-varients')?.innerText);
                const isPrescriptionRequired = !!card.querySelector('img[alt*="prescription required"]');
                const productImage = link.querySelector('img')?.getAttribute('src'); // Will capture URL even if blocked

                uniqueItems.push({ url, name, brand, productImage, packInfo, isPrescriptionRequired });
            });
            return uniqueItems;
        });
    } catch (err) {
        console.error(`❌ Critical Error extracting PLP data (Frame Detached?): ${err.message}`);
        // If we can't get the list, we can't scrape the category.
        return page;
    }

    // Disable interception for PDPs (we might want images there? actually let's keep it efficient)
    // For PDP scraping, if we need to see text content, blocking images is fine.
    // However, if the user script captures 'image' src, we are fine.
    // We will keep interception ON for PDPs too to keep it fast/stable.

    console.log(`📋 Found ${medicinesList.length} items in category.`);
    const medicinesData = [];

    for (let i = 0; i < medicinesList.length; i++) {
        // Recycle page every 50 items to prevent memory leaks/detached frames
        if (i > 0 && i % 50 === 0) {
            console.log('   ♻️ Refreshing browser tab to free memory...');
            try { await page.close(); } catch (e) { }
            page = await browser.newPage();
            await page.setViewport({ width: 1200, height: 800 });
        }

        const basicData = medicinesList[i];
        console.log(`   ➡️ Scraping Product ${i + 1}/${medicinesList.length}: ${basicData.name || 'Unknown'} (${basicData.url})`);

        try {
            // Navigate to the actual Product Detail Page
            await page.goto(basicData.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

            const detailedData = await page.evaluate((url) => {
                const clean = (s) => (s || '').replace(/\s+/g, ' ').trim() || null;
                const getInnerText = (selector) => clean(document.querySelector(selector)?.innerText);
                const getFullText = (selector) => {
                    const el = document.querySelector(selector);
                    return el ? el.innerText.trim() : null;
                };
                const getList = (selector) => Array.from(document.querySelectorAll(selector)).map(el => clean(el.innerText)).filter(Boolean);

                // PDP Specific Extraction
                const name = getInnerText('div.prod-name h1') || getInnerText('h1');
                const brand = clean(document.querySelector('div.drug-manu')?.innerText?.replace(/^By\s+/i, '') || document.querySelector('div.canget')?.innerText);
                const bestPrice = getInnerText('span.ess-price');
                const mrp = getInnerText('span.strike-price');
                const discountedPrice = getInnerText('span.price') || getInnerText('.priceDisplay');
                // Construct price object if any exist
                const price = (bestPrice || mrp || discountedPrice) ? { bestPrice, mrp, discountedPrice } : null;

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
                const warningsRaw = getFullText('#np_tab12') + (otherWarningsText ? '\n' + otherWarningsText : '');

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
                const category = Array.from(document.querySelectorAll('.canget .label, .breadcrumb .breadcrumb-item')).map(el => clean(el.innerText)).filter(Boolean);
                const images = Array.from(document.querySelectorAll('.image-gallery-box__list img, .pdp-image')).map(img => img.getAttribute('src') || img.src).filter(src => src && src.startsWith('http'));

                return {
                    introduction, uses: usesList, usesDetails, mechanismOfAction, usageInstructions: usageList, usageDetails,
                    sideEffects: sideEffectsList, sideEffectsDetails, warnings, warningsRaw, interactions, synopsis, moreInfo,
                    faqs, references, author, lastUpdated, category, composition: extractComposition(), images
                };
            }, basicData.url);

            medicinesData.push({ ...basicData, ...detailedData });

        } catch (err) {
            console.error(`   ❌ Failed to scrape PDP ${basicData.url}: ${err.message}`);
            medicinesData.push(basicData); // Fallback
        }

        // DELAY between products
        await new Promise(r => setTimeout(r, 2000));
    }

    await fs.writeFile(outputFile, JSON.stringify(medicinesData, null, 2));
    console.log(`💾 Saved category data to ${outputFile}`);
    return page;
}

async function autoScroll(page) {
    console.log('   📜 Auto-scrolling to load all products...');
    let previousHeight = 0;
    let noChangeCount = 0;
    const maxTime = 10 * 60 * 1000; // 10 minutes max scroll time
    const startTime = Date.now();

    while (true) {
        if (Date.now() - startTime > maxTime) {
            console.log('   ⚠️ Scroll time limit reached. Stopping scroll.');
            break;
        }

        try {
            // Scroll down
            const { scrollHeight, currentScroll } = await page.evaluate(() => {
                window.scrollBy(0, window.innerHeight * 2); // Scroll faster
                return {
                    scrollHeight: document.body.scrollHeight,
                    currentScroll: window.scrollY + window.innerHeight
                };
            });

            // Check validation
            if (scrollHeight === previousHeight) {
                noChangeCount++;
                if (noChangeCount >= 5) break; // Increased confidence
            } else {
                noChangeCount = 0;
                previousHeight = scrollHeight;
            }

            // Wait for potential network requests/lazy loading
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e) {
            console.log('   Warning: Error during scroll (continuing):', e.message);
            break; // If scroll crashes, stop scrolling and try to scrape what we have
        }
    }
    console.log('   ✅ Scrolling complete.');
}
