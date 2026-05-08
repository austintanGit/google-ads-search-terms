#!/usr/bin/env node
/**
 * Run against a Google Ads customer to see where negatives come from
 * and whether a given phrase appears (mirrors /api/negative-keywords GAQL).
 *
 * Usage: node scripts/diagnose-negatives.js <customerId> [needle]
 *   customerId — 10 digits, no dashes (same as app "clientId")
 *   needle     — optional substring to flag (default: chapter 7)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { GoogleAdsApi } = require('google-ads-api');

const customerId = process.argv[2]?.replace(/-/g, '');
const needle = (process.argv[3] || 'chapter 7').toLowerCase();

if (!customerId || !/^\d{10}$/.test(customerId)) {
  console.error('Usage: node scripts/diagnose-negatives.js <customerId> [needleSubstring]');
  console.error('  customerId must be 10 digits (no dashes), same as the app client ID.');
  process.exit(1);
}

const queries = {
  shared_criterion: `
            SELECT 
                shared_criterion.resource_name,
                shared_criterion.keyword.text,
                shared_criterion.keyword.match_type,
                shared_set.name,
                shared_set.status,
                shared_set.type,
                shared_set.member_count
            FROM shared_criterion
            WHERE 
                shared_set.type = NEGATIVE_KEYWORDS 
                AND shared_set.status = ENABLED`,
  campaign_criterion: `
            SELECT 
                campaign_criterion.resource_name,
                campaign_criterion.keyword.text,
                campaign_criterion.keyword.match_type,
                campaign.name,
                campaign.id
            FROM campaign_criterion
            WHERE 
                campaign_criterion.negative = true
                AND campaign_criterion.status = ENABLED`,
  ad_group_criterion: `
            SELECT 
                ad_group_criterion.resource_name,
                ad_group_criterion.keyword.text,
                ad_group_criterion.keyword.match_type,
                ad_group.name,
                ad_group.id,
                campaign.name,
                campaign.id
            FROM ad_group_criterion
            WHERE 
                ad_group_criterion.negative = true
                AND ad_group_criterion.status = ENABLED`,
  campaign_shared_set: `
            SELECT
                campaign.id,
                campaign.name,
                shared_set.id,
                shared_set.name,
                shared_set.resource_name
            FROM campaign_shared_set`,
};

function keywordText(row) {
  return (
    row.shared_criterion?.keyword?.text ||
    row.campaign_criterion?.keyword?.text ||
    row.ad_group_criterion?.keyword?.text ||
    ''
  );
}

function matchTypeFromRow(row) {
  const n =
    row.shared_criterion?.keyword?.match_type ??
    row.campaign_criterion?.keyword?.match_type ??
    row.ad_group_criterion?.keyword?.match_type;
  if (n === 2) return 'EXACT';
  if (n === 3) return 'PHRASE';
  if (n === 4) return 'BROAD';
  return String(n ?? '');
}

async function main() {
  const missing = ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_REFRESH_TOKEN'].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    console.error('Missing env:', missing.join(', '));
    process.exit(1);
  }

  const client = new GoogleAdsApi({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  });

  const customer = client.Customer({
    customer_id: customerId,
    login_customer_id: process.env.GOOGLE_ADS_MANAGER_ID,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
  });

  console.log('Customer:', customerId);
  console.log('Login customer (manager):', process.env.GOOGLE_ADS_MANAGER_ID || '(none)');
  console.log('Needle:', JSON.stringify(needle));
  console.log('');

  let totalNeedle = 0;

  for (const [label, query] of Object.entries(queries)) {
    process.stdout.write(`Query ${label}... `);
    try {
      const rows = await customer.query(query);
      console.log(`ok (${rows.length} rows)`);

      if (label === 'campaign_shared_set') {
        rows.slice(0, 30).forEach((r) => {
          console.log(
            `  campaign=${r.campaign?.id} ${r.campaign?.name} | list=${r.shared_set?.id} ${r.shared_set?.name}`
          );
        });
        if (rows.length > 30) console.log(`  ... ${rows.length - 30} more`);
        continue;
      }

      const chapterish = [];
      const needleHits = [];
      for (const row of rows) {
        const text = keywordText(row);
        if (!text) continue;
        const low = text.toLowerCase();
        if (low.includes('chapter')) chapterish.push({ text, matchType: matchTypeFromRow(row), row });
        if (low.includes(needle)) {
          needleHits.push({ text, matchType: matchTypeFromRow(row), row });
          totalNeedle++;
        }
      }

      if (chapterish.length) {
        console.log(`  Rows with "chapter" in keyword (${chapterish.length}):`);
        chapterish.slice(0, 50).forEach((h) => {
          const loc =
            label === 'shared_criterion'
              ? `list=${h.row.shared_set?.name}`
              : label === 'campaign_criterion'
                ? `campaign=${h.row.campaign?.name}`
                : `ad_group=${h.row.ad_group?.name} campaign=${h.row.campaign?.name}`;
          console.log(`    "${h.text}" [${h.matchType}] ${loc}`);
        });
        if (chapterish.length > 50) console.log(`    ... ${chapterish.length - 50} more`);
      } else {
        console.log('  No keywords containing "chapter" in this source.');
      }

      if (needleHits.length) {
        console.log(`  *** Needle "${needle}" (${needleHits.length} in ${label}):`);
        needleHits.forEach((h) => console.log(`      "${h.text}" [${h.matchType}]`));
      }
    } catch (e) {
      console.log('FAILED');
      console.error('  Message:', e.message);
      if (e.errors) console.error('  errors:', JSON.stringify(e.errors, null, 2));
    }
  }

  console.log('');
  console.log(
    totalNeedle
      ? `Summary: "${needle}" appears ${totalNeedle} time(s) across shared + campaign + ad_group criteria (exact phrase substring match on keyword text).`
      : `Summary: "${needle}" does NOT appear in keyword text for any row returned by those three queries.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
