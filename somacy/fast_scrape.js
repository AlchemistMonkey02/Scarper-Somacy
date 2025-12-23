const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

// --- CONFIGURATION ---
const CONCURRENT_CATEGORIES = 3; // Parallel browsers (Direct connection is faster/more stable)
const CONCURRENT_PRODUCTS_PER_BROWSER = 10; // Parallel tabs for detail scraping
const DATA_DIR = path.join(__dirname, 'data');
const MASTER_URL = 'https://www.netmeds.com/collection/all-medicines';

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

async function scrapeCategory(category) {
    const safeName = category.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const fileName = path.join(DATA_DIR, `${safeName}.json`);

    try {
        await fs.access(fileName);
        console.log(`⏩ Skipping ${category.name} (exists)`);
        return;
    } catch { }

    console.log(`🚀 [${category.name}] Starting Direct Scraping...`);

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800 });

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        console.log(`🔍 [${category.name}] Loading Listing Page...`);
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

        console.log(`📋 [${category.name}] Found ${products.length} products. Starting Details Scraping...`);

        const results = [];
        for (let i = 0; i < products.length; i += CONCURRENT_PRODUCTS_PER_BROWSER) {
            const batch = products.slice(i, i + CONCURRENT_PRODUCTS_PER_BROWSER);
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

            // Short delay between batches to be respectful
            await delay(1000);
        }

        await fs.writeFile(fileName, JSON.stringify(results, null, 2));
        console.log(`💾 [${category.name}] Completed and saved.`);

    } catch (err) {
        console.error(`❌ [${category.name}] Error: ${err.message}`);
    } finally {
        if (browser) await browser.close();
    }
}

async function main() {
    try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (err) { }

    console.log('🔍 Fetching master category list...');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    let categories = [];
    try {
        await page.goto(MASTER_URL, { waitUntil: 'networkidle2', timeout: 90000 });
        // Expand "more" buttons
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('div')).filter(el => /\+\s*\d+\s*more/i.test(el.innerText));
            buttons.forEach(btn => btn.click());
        });
        await delay(5000);
        categories = await page.$$eval('a[href*="categorynamelevel2="]', links =>
            links.map(l => ({ name: l.innerText.trim(), url: l.href }))
        );
    } catch (err) {
        console.error('❌ Master Page Error:', err.message);
        return;
    } finally {
        await browser.close();
    }

    console.log(`📦 Found ${categories.length} total categories. Executing parallel browsers...`);

    const queue = [...categories];
    const workers = [];

    for (let i = 0; i < CONCURRENT_CATEGORIES; i++) {
        workers.push((async () => {
            while (queue.length > 0) {
                const category = queue.shift();
                if (category) await scrapeCategory(category);
            }
        })());
    }

    await Promise.all(workers);
    console.log('🏁 ALL CATEGORIES FINISHED.');
}

main();
