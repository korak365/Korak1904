// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, Dataset, KeyValueStore } from 'crawlee';
import crypto from 'crypto';

// The init() call configures the Actor for its environment
await Actor.init();

// Structure of input is defined in input_schema.json
const {
    startUrls = [{ url: 'https://arxiv.org/list/cs.AI/recent' }],
    maxRequestsPerCrawl = 50,
    categories = ['cs.AI', 'cs.LG', 'cs.NLP'],
    extractEquations = true,
    extractTables = true,
    extractAbstract = true,
    extractMetadata = true,
    downloadPDF = false,
    extractFiguresCaptions = true,
    structuredOutput = true,
} = (await Actor.getInput()) ?? {};

// Proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration();

// Statistics tracking
const statistics = {
    papersScraped: 0,
    equationsExtracted: 0,
    tablesExtracted: 0,
    figuresExtracted: 0,
    errors: 0,
    startTime: new Date(),
};

// Storage for structured data
const allPapersData = [];

// Helper function to extract arxiv ID from URL
function extractArxivId(url) {
    const match = url.match(/arxiv\.org\/abs\/(\d+\.\d+)/);
    return match ? match[1] : null;
}

// Helper function to extract paper metadata from arXiv page
function extractPaperMetadata($, url) {
    const metadata = {
        arxivId: extractArxivId(url),
        url,
        title: $('h1.title').text().replace('Title:', '').trim() || $('h1').first().text().trim(),
        authors: [],
        publishedDate: '',
        submittedDate: '',
        category: '',
        abstract: '',
        keywords: [],
    };

    // Extract authors
    const authorText = $('div.authors').text();
    if (authorText) {
        metadata.authors = authorText
            .split(/\n|,/)
            .map((a) => a.trim())
            .filter((a) => a && a.length > 2);
    }

    // Extract dates
    const submittedText = $('div.dateline').text();
    if (submittedText) {
        const dates = submittedText.match(/(\d{1,2}\s+\w+\s+\d{4})/g);
        if (dates) {
            metadata.submittedDate = dates[0];
            if (dates[1]) metadata.publishedDate = dates[1];
        }
    }

    // Extract category
    const categoryText = $('span.primary-subject').text();
    metadata.category = categoryText.trim() || 'Unknown';

    // Extract abstract
    if (extractAbstract) {
        const abstractText = $('blockquote.abstract').text();
        metadata.abstract = abstractText.replace('Abstract:', '').trim();
    }

    return metadata;
}

// Helper function to extract equations
function extractEquations($, metadata) {
    const equations = [];
    let equationIndex = 0;

    // Look for LaTeX equations in the page content
    const content = $.html();

    // Simple regex patterns for LaTeX equations (this is simplified)
    const displayMathPattern = /\\\[([^\\\]]*)\\\]/g;
    const inlineMathPattern = /\$([^\$]+)\$/g;

    let match;

    // Extract display equations
    while ((match = displayMathPattern.exec(content)) !== null) {
        if (match[1].length > 5 && match[1].length < 500) {
            equationIndex++;
            equations.push({
                id: `eq-${equationIndex}`,
                latex: match[1].trim(),
                type: 'display',
                context: extractContext(content, match.index, 100),
            });
        }
    }

    // Extract inline equations (limited to avoid noise)
    const inlineMatches = Array.from(content.matchAll(inlineMathPattern))
        .slice(0, 50)
        .filter((m) => m[1].length > 5 && m[1].length < 200);

    inlineMatches.forEach((match, idx) => {
        equations.push({
            id: `inline-eq-${idx}`,
            latex: match[1].trim(),
            type: 'inline',
            context: '',
        });
    });

    return equations;
}

// Helper function to extract context around an equation
function extractContext(content, index, charRadius) {
    const start = Math.max(0, index - charRadius);
    const end = Math.min(content.length, index + charRadius);
    return content.substring(start, end).replace(/<[^>]*>/g, '').slice(0, 150);
}

// Helper function to extract tables
function extractTables($, metadata) {
    const tables = [];
    let tableIndex = 0;

    $('table').each((i, el) => {
        const $table = $(el);
        tableIndex++;

        // Extract table caption
        let caption = '';
        const captionEl = $table.prev('p, div').find('strong, em');
        if (captionEl.length) {
            caption = captionEl.text().trim();
        }

        // Extract table structure
        const headers = [];
        const rows = [];

        // Get headers
        $table.find('thead th, tr:first td').each((j, headerEl) => {
            headers.push($(headerEl).text().trim());
        });

        // Get rows
        $table.find('tbody tr, tr').each((rowIdx, rowEl) => {
            const $row = $(rowEl);
            const rowData = [];
            $row.find('td').each((cellIdx, cellEl) => {
                rowData.push($(cellEl).text().trim());
            });
            if (rowData.length > 0) {
                rows.push(rowData);
            }
        });

        // Convert table to array format
        const tableData = {
            id: `table-${tableIndex}`,
            caption,
            headers: headers.length > 0 ? headers : null,
            rows,
            rowCount: rows.length,
            columnCount: Math.max(...rows.map((r) => r.length), headers.length || 0),
        };

        tables.push(tableData);
    });

    return tables;
}

// Helper function to extract figure captions
function extractFiguresCaptions($) {
    const figures = [];
    let figureIndex = 0;

    $('figure, [class*="figure"]').each((i, el) => {
        const $fig = $(el);
        figureIndex++;

        const caption = $fig.find('figcaption, [class*="caption"]').text().trim();
        const altText = $fig.find('img').attr('alt') || '';

        if (caption || altText) {
            figures.push({
                id: `fig-${figureIndex}`,
                caption: caption || altText,
            });
        }
    });

    return figures;
}

// Helper function to extract references
function extractReferences($) {
    const references = [];

    // Look for reference sections
    const refSection = $('h2:contains("References"), h2:contains("Bibliography")').nextUntil('h2');

    refSection.filter('p, li').each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > 20) {
            references.push({
                id: `ref-${i + 1}`,
                text: text.slice(0, 300),
            });
        }
    });

    return references;
}

// Helper function to extract sections and content structure
function extractStructure($) {
    const structure = [];

    $('h1, h2, h3, h4').each((i, el) => {
        const $heading = $(el);
        const level = parseInt(el.name.substring(1));
        const title = $heading.text().trim();

        // Extract content following this heading until next heading
        let content = '';
        let nextEl = el.nextElementSibling;
        while (nextEl && !['H1', 'H2', 'H3', 'H4'].includes(nextEl.tagName)) {
            content += $(nextEl).text() + ' ';
            nextEl = nextEl.nextElementSibling;
        }

        structure.push({
            level,
            title,
            content: content.trim().slice(0, 500),
        });
    });

    return structure;
}

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ request, $, log }) {
        const url = request.loadedUrl;
        log.info(`Scraping: ${url}`);

        // Check if this is a paper page or listing page
        const isPaperPage = url.includes('/abs/');

        if (isPaperPage) {
            try {
                // Extract metadata
                const paperMetadata = extractPaperMetadata($, url);

                if (!paperMetadata.arxivId) {
                    log.warning(`Could not extract arxiv ID from ${url}`);
                    return;
                }

                // Initialize paper data object
                const paperData = {
                    ...paperMetadata,
                    equations: [],
                    tables: [],
                    figures: [],
                    references: [],
                    structure: [],
                    scrapedAt: new Date().toISOString(),
                };

                // Extract equations
                if (extractEquations) {
                    paperData.equations = extractEquations($, paperMetadata);
                    statistics.equationsExtracted += paperData.equations.length;
                }

                // Extract tables
                if (extractTables) {
                    paperData.tables = extractTables($, paperMetadata);
                    statistics.tablesExtracted += paperData.tables.length;
                }

                // Extract figures
                if (extractFiguresCaptions) {
                    paperData.figures = extractFiguresCaptions($);
                    statistics.figuresExtracted += paperData.figures.length;
                }

                // Extract references
                paperData.references = extractReferences($);

                // Extract document structure
                paperData.structure = extractStructure($);

                // Save paper overview to dataset
                await Dataset.pushData({
                    arxivId: paperMetadata.arxivId,
                    title: paperMetadata.title,
                    authors: paperMetadata.authors.join('; '),
                    publishedDate: paperMetadata.publishedDate,
                    category: paperMetadata.category,
                    abstract: paperMetadata.abstract.slice(0, 500),
                    url: paperMetadata.url,
                    equationsCount: paperData.equations.length,
                    tablesCount: paperData.tables.length,
                    figuresCount: paperData.figures.length,
                });

                // Save individual equations to dataset
                if (extractEquations && paperData.equations.length > 0) {
                    for (const equation of paperData.equations) {
                        await Dataset.pushData({
                            type: 'equation',
                            arxivId: paperMetadata.arxivId,
                            paperTitle: paperMetadata.title,
                            equationId: equation.id,
                            latex: equation.latex,
                            equationType: equation.type,
                            context: equation.context,
                        });
                    }
                }

                // Save individual tables to dataset
                if (extractTables && paperData.tables.length > 0) {
                    for (const table of paperData.tables) {
                        await Dataset.pushData({
                            type: 'table',
                            arxivId: paperMetadata.arxivId,
                            paperTitle: paperMetadata.title,
                            tableId: table.id,
                            caption: table.caption,
                            rowCount: table.rowCount,
                            columnCount: table.columnCount,
                        });
                    }
                }

                // Store full structured data
                allPapersData.push(paperData);

                statistics.papersScraped++;
                log.info(
                    `Saved paper: ${paperMetadata.title} (${paperData.equations.length} equations, ${paperData.tables.length} tables)`
                );
            } catch (error) {
                log.error(`Error extracting paper data from ${url}:`, error);
                statistics.errors++;
            }
        } else {
            // This is a listing page, extract links to individual papers
            const paperLinks = [];

            $('a[href*="/abs/"]').each((i, el) => {
                const link = $(el).attr('href');
                if (link && !paperLinks.includes(link)) {
                    paperLinks.push(`https://arxiv.org${link}`);
                }
            });

            log.info(`Found ${paperLinks.length} papers to scrape`);

            // Enqueue paper pages
            for (const paperUrl of paperLinks.slice(0, 20)) {
                await crawler.addRequests([{ url: paperUrl }]);
            }

            // Look for next page link
            const nextPageLink = $('a:contains("next")').attr('href');
            if (nextPageLink && statistics.papersScraped < maxRequestsPerCrawl) {
                const nextUrl = nextPageLink.startsWith('http') ? nextPageLink : `https://arxiv.org${nextPageLink}`;
                await crawler.addRequests([{ url: nextUrl }]);
            }
        }
    },

    errorHandler({ request, error, log }) {
        log.error(`Request failed: ${request.url}`, error);
        statistics.errors++;
    },
});

// Run the crawler
try {
    await crawler.run(startUrls);
} catch (error) {
    console.error('Crawler error:', error);
    statistics.errors++;
}

// Save structured output to Key-Value Store
const kvStore = await KeyValueStore.open();

// Create comprehensive export
const exportData = {
    exportDate: new Date().toISOString(),
    statistics,
    papers: allPapersData,
};

if (structuredOutput) {
    await kvStore.setValue('PAPERS_JSON_EXPORT', JSON.stringify(exportData, null, 2));
}

// Create extraction report
const extractionReport = {
    reportDate: new Date().toISOString(),
    summary: {
        totalPapersScraped: statistics.papersScraped,
        totalEquationsExtracted: statistics.equationsExtracted,
        totalTablesExtracted: statistics.tablesExtracted,
        totalFiguresExtracted: statistics.figuresExtracted,
        averageEquationsPerPaper:
            statistics.papersScraped > 0 ? (statistics.equationsExtracted / statistics.papersScraped).toFixed(2) : 0,
        averageTablesPerPaper:
            statistics.papersScraped > 0 ? (statistics.tablesExtracted / statistics.papersScraped).toFixed(2) : 0,
    },
    topPapers: allPapersData.sort((a, b) => b.equations.length - a.equations.length).slice(0, 10),
    errors: statistics.errors,
    duration: new Date() - statistics.startTime,
};

await kvStore.setValue('EXTRACTION_REPORT', JSON.stringify(extractionReport, null, 2));

console.log('\n=== arXiv Paper Extraction Complete ===');
console.log(`Papers scraped: ${statistics.papersScraped}`);
console.log(`Equations extracted: ${statistics.equationsExtracted}`);
console.log(`Tables extracted: ${statistics.tablesExtracted}`);
console.log(`Figures extracted: ${statistics.figuresExtracted}`);
console.log(`Errors: ${statistics.errors}`);
console.log(`\nAverage per paper:`);
console.log(
    `- Equations: ${(statistics.equationsExtracted / (statistics.papersScraped || 1)).toFixed(2)}`
);
console.log(`- Tables: ${(statistics.tablesExtracted / (statistics.papersScraped || 1)).toFixed(2)}`);

// Gracefully exit the Actor process
await Actor.exit();