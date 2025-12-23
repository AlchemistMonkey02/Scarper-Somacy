const puppeteer = require('puppeteer');
const fs = require('fs').promises;

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });

  // ✅ FIXED: no trailing spaces
  const acneMedicinesUrl = 'https://www.netmeds.com/collection/acne-medicines';

  console.log(`🔍 Navigating to: ${acneMedicinesUrl}`);
  await page.goto(acneMedicinesUrl, { waitUntil: 'domcontentloaded' });

  // ✅ FIXED: clean base URL
  const medicineLinks = await page.$$eval('.product-card a[href^="/product/"]', links =>
    [...new Set(links.map(a => 'https://www.netmeds.com' + a.getAttribute('href')))]
  );

  console.log(`📦 Found ${medicineLinks.length} medicine links.`);

  const medicinesData = [];

  for (let i = 0; i < Math.min(medicineLinks.length, 5); i++) {
    const url = medicineLinks[i];
    console.log(`➡️ Scraping ${i + 1}/${Math.min(medicineLinks.length, 5)}: ${url}`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try {
        await page.waitForSelector('.prod-name, h1', { timeout: 15000 });
      } catch {
        console.warn('⚠️ Product title selector not found — continuing.');
      }

      const data = await page.evaluate((url) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim() || null;

        const extractComposition = () => {
          // Table method
          const rows = Array.from(document.querySelectorAll('table tr'));
          for (const row of rows) {
            const cells = row.querySelectorAll('td, th');
            if (cells.length >= 2) {
              const label = (cells[0]?.innerText || '').toLowerCase();
              if (label.includes('composition') || label.includes('contains')) {
                return clean(cells[1]?.innerText || cells[2]?.innerText);
              }
            }
          }

          // Link method — ✅ FIXED base URL
          const link = document.querySelector('a[href*="contains="]');
          if (link && link.href) {
            try {
              const u = new URL(link.href, 'https://www.netmeds.com'); // ← NO spaces
              return clean(decodeURIComponent(u.searchParams.get('contains')?.replace(/\+/g, ' ') || ''));
            } catch {}
          }

          // Paragraph fallback
          const para = document.querySelector('.prescript-txt')?.innerText || '';
          const m = para.match(/contains a medicine called ([^.]+)/i);
          return m ? clean(m[1]) : null;
        };

        const name = clean(
          document.querySelector('.prod-name')?.innerText ||
          document.querySelector('h1')?.innerText ||
          ''
        );
        const brand = clean(document.querySelector('.brand-name, .manufacturer-name')?.innerText);
        const isPrescriptionRequired = !!document.querySelector('img[alt*="prescription required"]');
        const category = Array.from(document.querySelectorAll('.canget .label'))
          .map(el => clean(el.innerText)).filter(Boolean);

        const mrp = clean(document.querySelector('.retail-price')?.innerText);
        const discountedPrice = clean(document.querySelector('.final-price')?.innerText);
        const bestPrice = clean(document.querySelector('.coupon-value')?.innerText);
        const packInfo = clean(document.querySelector('.jm-body-xxxs-bold, .spec')?.innerText);
        const description = clean(document.querySelector('.prescript-txt')?.innerText);
        const composition = extractComposition();

        const usageInstructions = Array.from(document.querySelectorAll('#np_tab7 ol li, #np_tab7 ul li'))
          .map(li => clean(li.innerText)).filter(Boolean);
        const sideEffects = Array.from(document.querySelectorAll('#np_tab4 ul li, #np_tab4 p'))
          .map(p => clean(p.innerText)).filter(s => s && s.length > 10);

        const faqs = Array.from(document.querySelectorAll('#np_tab24 h2')).reduce((acc, h2) => {
          const q = clean(h2.innerText);
          let next = h2.nextElementSibling;
          let a = '';
          while (next && !['H1','H2','H3'].includes(next.tagName)) {
            if (['P','UL','OL'].includes(next.tagName)) a += ' ' + clean(next.innerText);
            next = next.nextElementSibling;
          }
          a = a.trim();
          if (q && a) acc.push({ question: q, answer: a });
          return acc;
        }, []);

        const images = Array.from(document.querySelectorAll('.image-gallery-box__list img, .pdp-image'))
          .map(img => img.src).filter(src => src && src.startsWith('http'));

        const author = clean(document.querySelector('.authorName')?.innerText);
        const lastUpdated = clean(
          document.querySelector('.upDated')?.innerText?.replace(/Last updated on\s*/i, '')
        );

        return {
          url,
          name,
          brand,
          isPrescriptionRequired,
          category,
          composition,
          packInfo,
          price: { mrp, discountedPrice, bestPrice },
          description,
          usageInstructions,
          sideEffects,
          faqs,
          images,
          author,
          lastUpdated
        };
      }, url);

      medicinesData.push(data);
      console.log(`✅ Scraped: ${data.name || '—'}`);
    } catch (err) {
      console.error(`❌ Failed to scrape ${url}:`, err.message || err);
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  await fs.writeFile('acne_medicines_data.json', JSON.stringify(medicinesData, null, 2));
  console.log(`✅ Saved ${medicinesData.length} items to acne_medicines_data.json`);
  await browser.close();
})();