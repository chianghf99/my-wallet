const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

async function extract() {
    const data = new Uint8Array(fs.readFileSync('ESUN_Estatement_11504.pdf'));
    const doc = await pdfjsLib.getDocument({ data: data }).promise;
    let fullText = "";
    for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        fullText += content.items.map(item => item.str).join(" ") + "\n";
    }
    console.log(fullText.substring(0, 1000));
}
extract().catch(console.error);
