const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'data', 'database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening DB:', err);
    process.exit(1);
  }
});

function parseDBDate(dateStr) {
  if (!dateStr) return null;
  const match = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (match) {
    return new Date(
      parseInt(match[3]),
      parseInt(match[2]) - 1,
      parseInt(match[1]),
      parseInt(match[4]),
      parseInt(match[5])
    );
  }
  return new Date(dateStr.split(' (UTC')[0]);
}

db.all("SELECT uid, reference, buyer_name, description, publish_date, submission_date, base_price_num FROM notices", [], (err, rows) => {
  if (err) {
    console.error('Error running:', err);
    db.close();
    return;
  }
  
  const results = [];
  rows.forEach(r => {
    const pub = parseDBDate(r.publish_date);
    const sub = parseDBDate(r.submission_date);
    if (pub && sub && !isNaN(pub.getTime()) && !isNaN(sub.getTime())) {
      const diffHrs = (sub.getTime() - pub.getTime()) / (1000 * 60 * 60);
      if (diffHrs > 0 && diffHrs <= 72) {
        results.push({
          uid: r.uid,
          reference: r.reference,
          buyer_name: r.buyer_name,
          description: r.description,
          publish_date: r.publish_date,
          submission_date: r.submission_date,
          hours_to_submit: Math.round(diffHrs * 10) / 10,
          base_price_num: r.base_price_num
        });
      }
    }
  });

  results.sort((a, b) => a.hours_to_submit - b.hours_to_submit);
  console.log('Directed Bidding matches:', JSON.stringify(results.slice(0, 5), null, 2));
  db.close();
});
