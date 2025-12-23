const fs = require('fs').promises;
const XLSX = require('xlsx');

(async () => {
    try {
        // 🔹 1. Read JSON file
        console.log('📂 Reading acne_medicines_data2.json...');
        const rawData = await fs.readFile('acne_medicines_data2.json', 'utf8');
        const medicines = JSON.parse(rawData);

        if (!Array.isArray(medicines) || medicines.length === 0) {
            throw new Error('No medicine data found in JSON file.');
        }

        // 🔹 2. Flatten nested data for Excel
        const rows = medicines.map(med => {
            const joinArray = (arr, sep = '\n') =>
                Array.isArray(arr) ? arr.filter(Boolean).join(sep) : (arr || '');

            // Helper: format FAQ as Q\nA\n\nQ\nA...
            const faqs = Array.isArray(med.faqs)
                ? med.faqs
                    .map(f => `${f.question || ''}\n${f.answer || ''}`)
                    .filter(qa => qa.trim() !== '\n')
                    .join('\n\n')
                : (med.faqs || '');

            // Helper: format Synopsis object
            const synopsis = med.synopsis && typeof med.synopsis === 'object'
                ? Object.entries(med.synopsis).map(([k, v]) => `${k}: ${v}`).join('\n')
                : '';

            // Helper: format Warnings (Structured)
            const warnings = Array.isArray(med.warnings)
                ? med.warnings.map(w => `[${w.category}] ${w.status || ''}\n${w.details || ''}`).join('\n\n')
                : '';

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
                'Author': med.author || '',
                'Last Updated': med.lastUpdated || ''
            };
        });

        // 🔹 3. Create workbook & worksheet
        const wb = XLSX.utils.book_new();

        // Define header order specifically
        const header = [
            'URL', 'Name', 'Brand', 'Prescription Required', 'Category', 'Composition',
            'Pack Info', 'MRP', 'Discounted Price', 'Best Price',
            'Introduction',
            'Uses (List)', 'Uses (Detailed)',
            'Mechanism of Action',
            'Usage Instructions (List)', 'Usage Instructions (Detailed)',
            'Side Effects (List)', 'Side Effects (Detailed)',
            'Warnings (Structured)', 'Warnings (Full Text)',
            'Interactions', 'Synopsis', 'More Info', 'References',
            'FAQs', 'Images', 'Author', 'Last Updated'
        ];

        const ws = XLSX.utils.json_to_sheet(rows, { header });

        // 🔹 4. Auto-size columns (max width 60)
        const colWidths = rows.reduce((widths, row) => {
            Object.entries(row).forEach(([key, value]) => {
                const str = String(value || '');
                const lines = str.split('\n');
                const maxLineLen = lines.reduce((w, line) => Math.max(w, line.length), 0);
                // Cap width between 10 and 60
                const width = Math.min(60, Math.max(10, maxLineLen));
                // Ensure header fits too
                const headerWidth = key.length;
                widths[key] = Math.max(widths[key] || headerWidth, width);
            });
            return widths;
        }, {});

        ws['!cols'] = header.map(key => ({ wch: colWidths[key] || 20 }));

        // 🔹 5. Add sheet to workbook
        XLSX.utils.book_append_sheet(wb, ws, 'Acne Medicines');

        // 🔹 6. Write Excel file
        XLSX.writeFile(wb, 'acne_medicines_data2.xlsx');
        console.log(`✅ Excel file saved: acne_medicines_data2.xlsx (${rows.length} rows)`);

    } catch (err) {
        console.error('❌ Error:', err.message || err);
    }
})();