const puppeteer = require('puppeteer');
const fs = require('fs').promises;

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    const collectionUrl = 'https://www.netmeds.com/collection/acne-medicines';

    console.log(`🔍 Navigating to: ${collectionUrl}`);
    await page.goto(collectionUrl, { waitUntil: 'networkidle2' });

    // ✅ Scroll to bottom to trigger lazy-load of all products
    await autoScroll(page);

    // ✅ Extract ALL unique product links (including lazy-loaded)
    // ✅ Extract BASIC details from PLP (Name, Price, etc.)
    const medicinesList = await page.$$eval('.product-card-container', cards => {
        return cards.map(card => {
            const clean = (s) => (s || '').replace(/\s+/g, ' ').trim() || null;

            const linkEl = card.querySelector('a[href^="/product/"]');
            const href = linkEl ? linkEl.getAttribute('href').trim() : null;
            const url = href ? 'https://www.netmeds.com' + href : null;

            if (!url) return null;

            // Name & Brand
            const name = clean(card.querySelector('.product-desc h3')?.innerText);
            const brand = clean(card.querySelector('.regular-xxxs')?.innerText?.replace(/^By\s+/i, ''));
            const packInfo = clean(card.querySelector('.jm-body-xxxs')?.innerText);

            // Rx Status
            const isPrescriptionRequired = !!card.querySelector('img[alt*="prescription required"]');

            // Price - Prioritize best price, then effective price
            const bestPrice = clean(card.querySelector('.best-price-value')?.innerText);
            const discountedPrice = clean(card.querySelector('.priceDisplay')?.innerText);
            const mrp = clean(card.querySelector('.mrp .strick')?.innerText || card.querySelector('.mrp')?.innerText);
            const discount = clean(card.querySelector('.discount')?.innerText);
            const productImage = card.querySelector('.imgClass img')?.getAttribute('src');

            return {
                url,
                name,
                brand,
                productImage, // Add image to basic details
                packInfo,
                isPrescriptionRequired,
                price: {
                    bestPrice,
                    discountedPrice,
                    mrp,
                    discount
                }
            };
        }).filter(Boolean); // Filter out nulls
    });

    console.log(`📦 Found ${medicinesList.length} medicines.`);

    const medicinesData = [];

    for (let i = 0; i < medicinesList.length; i++) {
        const basicData = medicinesList[i];
        console.log(`➡️ Scraping ${i + 1}/${medicinesList.length}: ${basicData.name} (${basicData.url})`);

        try {
            await page.goto(basicData.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

            // Wait for essential elements (allow fallback if missing)
            try {
                await page.waitForSelector('.prod-name, h1', { timeout: 15000 });
            } catch {
                console.warn('⚠️ Timed out waiting for product name — continuing...');
            }

            const detailedData = await page.evaluate((url) => {
                const clean = (s) => (s || '').replace(/\s+/g, ' ').trim() || null;
                const getInnerText = (selector) => clean(document.querySelector(selector)?.innerText);
                // New helper to get full text with newlines preserved if needed, or just clean space
                const getFullText = (selector) => {
                    const el = document.querySelector(selector);
                    if (!el) return null;
                    return el.innerText.trim();  // Keep newlines for readability in large blocks? Or flatten? User said "gather completely". InnerText is best.
                };
                const getList = (selector) => Array.from(document.querySelectorAll(selector)).map(el => clean(el.innerText)).filter(Boolean);

                const extractComposition = () => {
                    // Method 1: Link
                    const link = document.querySelector('a[href*="contains="]');
                    if (link && link.href) {
                        try {
                            const u = new URL(link.href, 'https://www.netmeds.com');
                            const contains = u.searchParams.get('contains');
                            if (contains) return decodeURIComponent(contains.replace(/\+/g, ' '));
                        } catch { }
                    }
                    // Method 2: Intro
                    const intro = document.querySelector('.prescript-txt')?.innerText || '';
                    const match = intro.match(/contains a medicine called ([^.]+)/i);
                    if (match) return clean(match[1]);
                    // Method 3: Table
                    const rows = Array.from(document.querySelectorAll('table tr'));
                    for (const row of rows) {
                        const cells = row.querySelectorAll('td, th');
                        if (cells.length >= 2) {
                            const label = (cells[0]?.innerText || '').toLowerCase();
                            if (label.includes('composition') || label.includes('active ingredient')) {
                                return clean(cells[1]?.innerText || cells[2]?.innerText);
                            }
                        }
                    }
                    return null;
                };

                // Detailed Extraction based on provided HTML structure
                // We fetch both specific lists (for structured data) AND full text (to ensure nothing is missed)

                const introduction = getFullText('#np_tab1 .inner-content');

                const usesList = getList('#np_tab3 li');
                const usesDetails = getFullText('#np_tab3 .inner-content'); // Backup/Full context

                const mechanismOfAction = getFullText('#np_tab6 .inner-content');

                const usageList = getList('#np_tab7 li');
                const usageDetails = getFullText('#np_tab7 .inner-content');

                const sideEffectsList = getList('#np_tab10 li, #np_tab4 li'); // Support both IDs
                // Capture the introductory text and the list together
                const sideEffectsDetails = getFullText('#np_tab10 .inner-content') || getFullText('#np_tab4 .inner-content');

                // Warnings & Precautions (Structured)
                const warnings = Array.from(document.querySelectorAll('#np_tab12 .manage-content')).map(el => {
                    return {
                        category: clean(el.querySelector('.manage-leftcontent h3')?.innerText),
                        status: clean(el.querySelector('.manage-leftcontent span')?.innerText),
                        details: clean(el.querySelector('.manage-rightcontent p')?.innerText)
                    };
                });
                const otherWarningsText = getFullText('#np_tab12_12 .inner-content');
                if (otherWarningsText) {
                    warnings.push({ category: "Others", status: "Warning", details: otherWarningsText });
                }
                // Also capture full raw text of warnings section just in case
                const warningsRaw = getFullText('#np_tab12') + (otherWarningsText ? '\n' + otherWarningsText : '');

                const interactions = getFullText('#np_tab18 .inner-content');

                // Synopsis (Table)
                const synopsis = {};
                const synopsisRows = document.querySelectorAll('#np_tab21 table tr');
                synopsisRows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 3) {
                        const key = clean(cells[0].innerText).replace(/:$/, '');
                        const val = clean(cells[2].innerText);
                        if (key && val) synopsis[key] = val;
                    }
                });

                const moreInfo = getFullText('#np_tab22 .inner-content');

                // References
                const references = getList('#np_tab25 p, #np_tab25 li');

                // FAQs
                const faqs = [];
                const faqContainer = document.querySelector('#np_tab24 .inner-content');
                if (faqContainer) {
                    const faqElems = Array.from(faqContainer.children);
                    let currentQ = null;
                    let currentA = [];

                    faqElems.forEach(el => {
                        const text = clean(el.innerText);
                        const tagName = el.tagName;
                        if (tagName === 'H2' && (text.startsWith('Q:') || text.includes('?') || text.includes('FAQs'))) {
                            // Sometimes "FAQs About..." is H2 and not a question. Skip if it doesn't look like a question? 
                            // But usually Q: is present.
                            if (text.startsWith('Q:') || text.includes('?')) {
                                if (currentQ) {
                                    faqs.push({ question: currentQ, answer: currentA.join(' ').trim() });
                                }
                                currentQ = text;
                                currentA = [];
                            }
                        } else if (currentQ) {
                            if (['P', 'UL', 'OL', 'LI', 'IFRAME', 'DIV'].includes(tagName)) {
                                currentA.push(text);
                            }
                        }
                    });
                    if (currentQ) {
                        faqs.push({ question: currentQ, answer: currentA.join(' ').trim() });
                    }
                }

                // Author & Last Updated
                const author = clean(document.querySelector('.authorName')?.innerText || document.querySelector('#np_tab28 .authorName')?.innerText);
                const lastUpdatedEl = document.querySelector('.upDated');
                const lastUpdated = lastUpdatedEl ? clean(lastUpdatedEl.innerText.replace(/Last updated on\s*/i, '')) : null;

                // Category
                const category = Array.from(document.querySelectorAll('.canget .label, .breadcrumb .breadcrumb-item')).map(el => clean(el.innerText)).filter(Boolean);

                // Images
                const images = Array.from(document.querySelectorAll('.image-gallery-box__list img, .pdp-image'))
                    .map(img => img.getAttribute('src') || img.src)
                    .filter(src => src && src.startsWith('http'));

                return {
                    introduction,
                    uses: usesList,
                    usesDetails,
                    mechanismOfAction,
                    usageInstructions: usageList,
                    usageDetails,
                    sideEffects: sideEffectsList,
                    sideEffectsDetails,
                    warnings,
                    warningsRaw,
                    interactions,
                    synopsis,
                    moreInfo,
                    faqs,
                    references,
                    author,
                    lastUpdated,
                    category,
                    composition: extractComposition(),
                    images
                };
            }, basicData.url);

            // Merge PLP data with PDP data
            medicinesData.push({
                ...basicData,
                ...detailedData
            });

            console.log(`✅ Scraped: ${basicData.name}`);
        } catch (err) {
            console.error(`❌ Failed to scrape ${basicData.url}:`, err.message);
            // Push basic data even if PDP fails
            medicinesData.push(basicData);
        }

        // Be respectful — delay between requests
        await new Promise(r => setTimeout(r, 1000));
    }

    // Save to JSON
    await fs.writeFile('acne_medicines_data3.json', JSON.stringify(medicinesData, null, 2));
    console.log(`✅ Successfully saved ${medicinesData.length} medicines to acne_medicines_data2.json`);

    await browser.close();
})();

// Helper: Auto-scroll to bottom to load lazy content
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 50);
        });
    });
}