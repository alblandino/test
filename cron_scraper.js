const db = require('./db');
const scraper = require('./scraper');

console.log('==================================================');
console.log('   AUTOMATED CONTRACT NOTICE SCHEDULER STARTED   ');
console.log('==================================================');
console.log(`Initial DB engine connected: ${db.getEngine()}`);

// Hourly interval: 1 hour = 60 minutes * 60 seconds * 1000 milliseconds
const HOURLY_INTERVAL_MS = 60 * 60;// * 1000;

async function executeScrapeCycle() {
  const status = scraper.getStatus();
  if (status.isScraping) {
    console.log(`[Scheduler ${new Date().toLocaleTimeString()}] A scraping cycle is already running (Run ID: #${status.currentRunId}). Skipping start.`);
    return;
  }
  
  console.log(`[Scheduler ${new Date().toLocaleTimeString()}] Triggering automated scraper for page 1 (latest 100 notices)...`);
  const success = scraper.runScraper(100);
  if (success) {
    console.log('[Scheduler] Background scraping task started successfully.');
  } else {
    console.log('[Scheduler] Failed to trigger background scraping task.');
  }
}

// Run immediately on startup once
setTimeout(() => {
  console.log('[Scheduler] Running initial startup sync cycle...');
  executeScrapeCycle();
}, 2000);

// Schedule to run every hour
setInterval(executeScrapeCycle, HOURLY_INTERVAL_MS);

console.log(`Automated schedule registered. Running background syncs every 1 hour (${HOURLY_INTERVAL_MS}ms).`);
