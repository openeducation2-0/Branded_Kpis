/*
 * Client-side view-builder: turns the flat rows exported by etl/03_export_deck_json.py into the
 * SAME shaped object template.html's render functions already consume as DATA_BY_DECK[deckId]
 * (meta/actuals/budget/trends/budgetTrends/dailyTrackerBudget/yoyByCountry/yoyDailyByCountry/
 * spendMixBranded/marketingOrgSplit/actualsByCountryMktOrg/yoyByCountryMktOrg -- all 12 contract
 * keys). Developed and verified number-for-number against the OLD Python pipeline's own published
 * data_all_decks.json in etl/viewBuilder.dev.js (run via Node, see etl/test_*.js) BEFORE being
 * copied here unchanged (this file has no module.exports/require -- everything below is a plain
 * global function/const, loaded via a normal <script> tag) -- see the project memory for why that
 * order (verify in isolation, then integrate) matters, and for the 2 real data-quality bugs found
 * and fixed while building this (Chile/March 2026 budget comma-typo; a `country='LATAM'`
 * aggregation code silently inflating "Other").
 */
'use strict';

const LATAM_NAMED = new Set(['Argentina', 'Chile', 'Colombia', 'Costa Rica', 'Ecuador', 'Mexico', 'Peru']);
const LATAM_COUNTRIES = ['Mexico', 'Argentina', 'Colombia', 'Chile', 'Ecuador', 'Peru', 'Costa Rica', 'Other'];
const LATAM_RESIDUAL = new Set(['Bolivia', 'Dominican Republic', 'El Salvador', 'Guatemala', 'Honduras',
  'Nicaragua', 'Panama', 'Paraguay', 'Uruguay', 'TV LATAM Excl Arg Mex']);

/** Returns the bucket key for a row's country, or null if the row should be DROPPED entirely
 * (aggregation/junk codes like "LATAM" -- not a real country, must not be folded into "Other"). */
function bucketCountry(country, isBrazilDeck) {
  if (isBrazilDeck) return country === 'Brazil' ? 'Brazil' : null;
  if (LATAM_NAMED.has(country)) return country;
  if (LATAM_RESIDUAL.has(country)) return 'Other';
  return null;
}

const CHANNEL_KEY_MAP = {
  'Brand TV Channels': 'branded',
  'Google Channels': 'google',
  'Paid social ASC only': 'paidSocialASC',
  'Paid social without ASC': 'paidSocialNoASC',
  'Social Organic': 'socialOrganic',
  'Others': 'others',
};
const CHANNEL_KEYS = Object.keys(CHANNEL_KEY_MAP).map(k => CHANNEL_KEY_MAP[k]);

function emptyTotals() {
  return { Spend: 0, Leads: 0, Sales: 0, NewCash: 0, FullCM: 0, ProjRevShort: 0, TotalEnrollments: 0 };
}

function addDailyRowInto(acc, r) {
  acc.Spend += r.spend || 0;
  acc.Leads += r.leadsEligible || 0;
  acc.Sales += r.coreEnrollmentsTotal || 0;
  acc.NewCash += r.newCashCore || 0;
}

function addKpiRowInto(acc, r) {
  acc.FullCM += r.fullCmShortUsd || 0;
  acc.ProjRevShort += r.projRevShortTotal || 0;
  acc.TotalEnrollments += r.totalEnrollments || 0;
}

function deriveRatios(t) {
  t.LtvShort = t.TotalEnrollments ? t.ProjRevShort / t.TotalEnrollments : null;
  t.FullUnitCmShort = t.TotalEnrollments ? t.FullCM / t.TotalEnrollments : null;
  t.FullCmPctShort = t.ProjRevShort ? t.FullCM / t.ProjRevShort : null;
  return t;
}

function buildActuals(dailyRows, channelKpiRows, startDate, endDate, isBrazilDeck) {
  const byChannelCountry = {};
  for (const key of CHANNEL_KEYS) byChannelCountry[key] = {};

  for (const r of dailyRows) {
    if (r.date < startDate || r.date > endDate) continue;
    const chKey = CHANNEL_KEY_MAP[r.channel_grouping];
    if (!chKey) continue;
    const country = bucketCountry(r.country, isBrazilDeck);
    if (country === null) continue;
    const bucket = byChannelCountry[chKey][country] || (byChannelCountry[chKey][country] = emptyTotals());
    addDailyRowInto(bucket, r);
  }
  for (const r of channelKpiRows) {
    if (r.date < startDate || r.date > endDate) continue;
    const chKey = CHANNEL_KEY_MAP[r.channel_grouping];
    if (!chKey) continue;
    const country = bucketCountry(r.country, isBrazilDeck);
    if (country === null) continue;
    const bucket = byChannelCountry[chKey][country] || (byChannelCountry[chKey][country] = emptyTotals());
    addKpiRowInto(bucket, r);
  }

  const actuals = {};
  for (const chKey of CHANNEL_KEYS) {
    const byCountry = byChannelCountry[chKey];
    const total = emptyTotals();
    for (const country in byCountry) {
      const t = byCountry[country];
      deriveRatios(t);
      for (const f of ['Spend', 'Leads', 'Sales', 'NewCash', 'FullCM', 'ProjRevShort', 'TotalEnrollments']) {
        total[f] += t[f];
      }
    }
    deriveRatios(total);
    actuals[chKey] = isBrazilDeck ? { total } : { byCountry, total };
  }

  const psKeys = ['paidSocialASC', 'paidSocialNoASC', 'socialOrganic'];
  const psTotal = emptyTotals();
  for (const k of psKeys) {
    for (const f of ['Spend', 'Leads', 'Sales', 'NewCash', 'FullCM', 'ProjRevShort', 'TotalEnrollments']) {
      psTotal[f] += actuals[k].total[f];
    }
  }
  deriveRatios(psTotal);
  actuals.paidSocialPlusOrganic = { total: psTotal };

  const blTotal = emptyTotals();
  for (const k of CHANNEL_KEYS) {
    for (const f of ['Spend', 'Leads', 'Sales', 'NewCash', 'FullCM', 'ProjRevShort', 'TotalEnrollments']) {
      blTotal[f] += actuals[k].total[f];
    }
  }
  deriveRatios(blTotal);
  actuals.blended = { total: blTotal };

  return actuals;
}

function buildBudget(budgetRows, monthStart) {
  const byChannel = {};
  for (const key of CHANNEL_KEYS) byChannel[key] = { Spend: 0, Leads: 0, Sales: 0, NewCash: 0 };

  for (const r of budgetRows) {
    if (r.month !== monthStart) continue;
    const chKey = CHANNEL_KEY_MAP[r.channel_grouping];
    if (!chKey) continue;
    const b = byChannel[chKey];
    b.Spend += r.spend || 0;
    b.Leads += r.leads || 0;
    b.Sales += r.sales || 0;
    b.NewCash += r.newCashCore || 0;
  }

  const psPlusOrganic = { Spend: 0, Leads: 0, Sales: 0, NewCash: 0 };
  for (const k of ['paidSocialASC', 'paidSocialNoASC', 'socialOrganic']) {
    for (const f of ['Spend', 'Leads', 'Sales', 'NewCash']) psPlusOrganic[f] += byChannel[k][f];
  }
  const blended = { Spend: 0, Leads: 0, Sales: 0, NewCash: 0 };
  for (const k of CHANNEL_KEYS) {
    for (const f of ['Spend', 'Leads', 'Sales', 'NewCash']) blended[f] += byChannel[k][f];
  }

  return {
    branded: { total: byChannel.branded },
    google: byChannel.google,
    asc: byChannel.paidSocialASC,
    paidSocial: byChannel.paidSocialNoASC,
    socialOrganic: byChannel.socialOrganic,
    paidSocialPlusOrganic: psPlusOrganic,
    others: byChannel.others,
    blended,
  };
}

const MONTH_NAMES = { 1: 'Ene', 2: 'Feb', 3: 'Mar', 4: 'Abr', 5: 'May', 6: 'Jun', 7: 'Jul', 8: 'Ago', 9: 'Sep', 10: 'Oct', 11: 'Nov', 12: 'Dic' };

function monthBounds(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

function buildTrends(dailyRows, year, throughMonth, isBrazilDeck) {
  const trends = {};
  for (const chKey of CHANNEL_KEYS) trends[chKey] = [];

  for (let m = 1; m <= throughMonth; m++) {
    const { start, end } = monthBounds(year, m);
    const byChannel = {};
    for (const chKey of CHANNEL_KEYS) byChannel[chKey] = emptyTotals();
    for (const r of dailyRows) {
      if (r.date < start || r.date > end) continue;
      const chKey = CHANNEL_KEY_MAP[r.channel_grouping];
      if (!chKey) continue;
      addDailyRowInto(byChannel[chKey], r);
    }
    for (const chKey of CHANNEL_KEYS) {
      const t = byChannel[chKey];
      trends[chKey].push({
        month: m, label: MONTH_NAMES[m],
        Spend: t.Spend, Leads: t.Leads, Sales: t.Sales, NewCash: t.NewCash,
        CPL: t.Leads ? t.Spend / t.Leads : null,
        CMPS: t.Sales ? t.Spend / t.Sales : null,
        MarginPct: t.NewCash ? (t.NewCash - t.Spend) / t.NewCash : null,
      });
    }
  }

  const psKeys = ['paidSocialASC', 'paidSocialNoASC', 'socialOrganic'];
  trends.paidSocialPlusOrganic = [];
  trends.blended = [];
  for (let i = 0; i < throughMonth; i++) {
    const psSum = { Spend: 0, Leads: 0, Sales: 0, NewCash: 0 };
    for (const k of psKeys) {
      psSum.Spend += trends[k][i].Spend; psSum.Leads += trends[k][i].Leads;
      psSum.Sales += trends[k][i].Sales; psSum.NewCash += trends[k][i].NewCash;
    }
    trends.paidSocialPlusOrganic.push({
      month: i + 1, label: MONTH_NAMES[i + 1], ...psSum,
      CPL: psSum.Leads ? psSum.Spend / psSum.Leads : null,
      CMPS: psSum.Sales ? psSum.Spend / psSum.Sales : null,
      MarginPct: psSum.NewCash ? (psSum.NewCash - psSum.Spend) / psSum.NewCash : null,
    });

    const blSum = { Spend: 0, Leads: 0, Sales: 0, NewCash: 0 };
    for (const k of CHANNEL_KEYS) {
      blSum.Spend += trends[k][i].Spend; blSum.Leads += trends[k][i].Leads;
      blSum.Sales += trends[k][i].Sales; blSum.NewCash += trends[k][i].NewCash;
    }
    trends.blended.push({
      month: i + 1, label: MONTH_NAMES[i + 1], ...blSum,
      CPL: blSum.Leads ? blSum.Spend / blSum.Leads : null,
      CMPS: blSum.Sales ? blSum.Spend / blSum.Sales : null,
      MarginPct: blSum.NewCash ? (blSum.NewCash - blSum.Spend) / blSum.NewCash : null,
    });
  }

  return trends;
}

function buildBudgetTrends(budgetRows, year, throughMonth) {
  const budgetTrends = {};
  for (const chKey of CHANNEL_KEYS) budgetTrends[chKey] = [];

  for (let m = 1; m <= throughMonth; m++) {
    const monthStr = `${year}-${String(m).padStart(2, '0')}-01`;
    const byChannel = {};
    for (const chKey of CHANNEL_KEYS) byChannel[chKey] = { Spend: 0, Leads: 0, Sales: 0, NewCash: 0 };
    for (const r of budgetRows) {
      if (r.month !== monthStr) continue;
      const chKey = CHANNEL_KEY_MAP[r.channel_grouping];
      if (!chKey) continue;
      byChannel[chKey].Spend += r.spend || 0;
      byChannel[chKey].Leads += r.leads || 0;
      byChannel[chKey].Sales += r.sales || 0;
      byChannel[chKey].NewCash += r.newCashCore || 0;
    }
    for (const chKey of CHANNEL_KEYS) {
      budgetTrends[chKey].push({ month: m, label: MONTH_NAMES[m], ...byChannel[chKey] });
    }
  }

  budgetTrends.paidSocialPlusOrganic = [];
  budgetTrends.blended = [];
  const psKeys2 = ['paidSocialASC', 'paidSocialNoASC', 'socialOrganic'];
  for (let i = 0; i < throughMonth; i++) {
    const psSum = { month: i + 1, label: MONTH_NAMES[i + 1], Spend: 0, Leads: 0, Sales: 0, NewCash: 0 };
    for (const k of psKeys2) {
      psSum.Spend += budgetTrends[k][i].Spend; psSum.Leads += budgetTrends[k][i].Leads;
      psSum.Sales += budgetTrends[k][i].Sales; psSum.NewCash += budgetTrends[k][i].NewCash;
    }
    budgetTrends.paidSocialPlusOrganic.push(psSum);

    const blSum = { month: i + 1, label: MONTH_NAMES[i + 1], Spend: 0, Leads: 0, Sales: 0, NewCash: 0 };
    for (const k of CHANNEL_KEYS) {
      blSum.Spend += budgetTrends[k][i].Spend; blSum.Leads += budgetTrends[k][i].Leads;
      blSum.Sales += budgetTrends[k][i].Sales; blSum.NewCash += budgetTrends[k][i].NewCash;
    }
    budgetTrends.blended.push(blSum);
  }

  return budgetTrends;
}

function buildDailyTrackerBudget(dailyTrackerBudgetRows, startDate, endDate, isBrazilDeck) {
  const empty = () => ({ Spend: 0, Leads: 0, Sales: 0, NewCash: 0 });
  const byCountry = {};
  for (const r of dailyTrackerBudgetRows) {
    if (r.date < startDate || r.date > endDate) continue;
    const b = byCountry[r.country] || (byCountry[r.country] = empty());
    b.Spend += r.spend || 0;
    b.Leads += r.leads || 0;
    b.Sales += r.sales || 0;
    b.NewCash += r.newCashCore || 0;
  }
  if (isBrazilDeck) {
    return { Brazil: byCountry.Brazil || empty() };
  }
  const out = {};
  for (const c of LATAM_COUNTRIES) out[c] = byCountry[c] || empty();
  return out;
}

const YOY_FIELDS = ['Spend', 'Leads', 'Sales', 'NewCash', 'FullCM', 'ProjRevShort', 'TotalEnrollments'];

function toIsoUTC(dt) { return dt.toISOString().slice(0, 10); }
function addDaysUTC(dt, n) { const r = new Date(dt); r.setUTCDate(r.getUTCDate() + n); return r; }

function computeYoyWindows(cutoffDate) {
  const [y, m, d] = cutoffDate.split('-').map(Number);
  const thisYearDay1 = new Date(Date.UTC(y, m - 1, 1));
  const lastYearDay1 = new Date(Date.UTC(y - 1, m - 1, 1));
  const shift = ((thisYearDay1.getUTCDay() - lastYearDay1.getUTCDay()) % 7 + 7) % 7;
  const exactStart = lastYearDay1;
  const exactEnd = addDaysUTC(lastYearDay1, d - 1);
  const shiftedStart = addDaysUTC(lastYearDay1, shift);
  const shiftedEnd = addDaysUTC(shiftedStart, d - 1);
  return {
    exactStart: toIsoUTC(exactStart), exactEnd: toIsoUTC(exactEnd),
    shiftedStart: toIsoUTC(shiftedStart), shiftedEnd: toIsoUTC(shiftedEnd),
  };
}

function mediaSpendByCountry(brandedTypeRows, startDate, endDate, isBrazilDeck) {
  const out = {};
  for (const r of brandedTypeRows) {
    if (r.date < startDate || r.date > endDate) continue;
    if (r.type === 'SEM-Brand') continue;
    const c = bucketCountry(r.country, isBrazilDeck);
    if (c === null) continue;
    out[c] = (out[c] || 0) + (r.spend || 0);
  }
  return out;
}

function paidOrganicSpendByCountry(dailyRows, startDate, endDate, isBrazilDeck) {
  const out = {};
  for (const r of dailyRows) {
    if (r.date < startDate || r.date > endDate) continue;
    const chKey = CHANNEL_KEY_MAP[r.channel_grouping];
    if (chKey !== 'paidSocialASC' && chKey !== 'paidSocialNoASC') continue;
    const c = bucketCountry(r.country, isBrazilDeck);
    if (c === null) continue;
    out[c] = (out[c] || 0) + (r.spend || 0);
  }
  return out;
}

function buildYoyByCountry(dailyRows, channelKpiRows, brandedTypeRows, cutoffDate, isBrazilDeck) {
  const { exactStart, exactEnd, shiftedStart, shiftedEnd } = computeYoyWindows(cutoffDate);
  const countries = isBrazilDeck ? ['Brazil'] : LATAM_COUNTRIES;

  function windowPayload(start, end) {
    const actuals = buildActuals(dailyRows, channelKpiRows, start, end, isBrazilDeck);
    const brandedByCountry = isBrazilDeck ? { Brazil: actuals.branded.total } : actuals.branded.byCountry;
    const media = mediaSpendByCountry(brandedTypeRows, start, end, isBrazilDeck);
    const paidOrganic = paidOrganicSpendByCountry(dailyRows, start, end, isBrazilDeck);
    const out = {};
    for (const c of countries) {
      const base = brandedByCountry[c];
      const row = {};
      for (const f of YOY_FIELDS) row[f] = (base && base[f]) || 0;
      row.MediaSpend = media[c] || 0;
      row.PaidOrganicSpend = paidOrganic[c] || 0;
      out[c] = row;
    }
    return out;
  }

  return {
    exact: windowPayload(exactStart, exactEnd),
    shifted: windowPayload(shiftedStart, shiftedEnd),
    exactRange: { start: exactStart, end: exactEnd },
    shiftedRange: { start: shiftedStart, end: shiftedEnd },
  };
}

function emptyDailyCountryRow(date, country) {
  return {
    date, country, Spend: 0, Leads: 0, Sales: 0, NewCash: 0, FullCM: 0, ProjRevShort: 0,
    TotalEnrollments: 0, MediaSpend: 0, PaidOrganicSpend: 0,
  };
}

function buildYoyDailyByCountry(dailyRows, channelKpiRows, brandedTypeRows, isBrazilDeck) {
  const byKey = {};
  function getRow(date, country) {
    const k = date + '|' + country;
    return byKey[k] || (byKey[k] = emptyDailyCountryRow(date, country));
  }

  for (const r of dailyRows) {
    if (r.channel_grouping !== 'Brand TV Channels') continue;
    const c = bucketCountry(r.country, isBrazilDeck);
    if (c === null) continue;
    const row = getRow(r.date, c);
    row.Spend += r.spend || 0;
    row.Leads += r.leadsEligible || 0;
    row.Sales += r.coreEnrollmentsTotal || 0;
    row.NewCash += r.newCashCore || 0;
  }
  for (const r of channelKpiRows) {
    if (r.channel_grouping !== 'Brand TV Channels') continue;
    const c = bucketCountry(r.country, isBrazilDeck);
    if (c === null) continue;
    const row = getRow(r.date, c);
    row.FullCM += r.fullCmShortUsd || 0;
    row.ProjRevShort += r.projRevShortTotal || 0;
    row.TotalEnrollments += r.totalEnrollments || 0;
  }
  for (const r of brandedTypeRows) {
    if (r.type === 'SEM-Brand') continue;
    const c = bucketCountry(r.country, isBrazilDeck);
    if (c === null) continue;
    const row = getRow(r.date, c);
    row.MediaSpend += r.spend || 0;
  }
  for (const r of dailyRows) {
    const chKey = CHANNEL_KEY_MAP[r.channel_grouping];
    if (chKey !== 'paidSocialASC' && chKey !== 'paidSocialNoASC') continue;
    const c = bucketCountry(r.country, isBrazilDeck);
    if (c === null) continue;
    const row = getRow(r.date, c);
    row.PaidOrganicSpend += r.spend || 0;
  }

  const allRows = Object.values(byKey);
  return { current: allRows, prior: allRows };
}

function buildSpendMixBranded(dailyRows, year, throughMonth) {
  const series = [];
  for (let m = 1; m <= throughMonth; m++) {
    const { start, end } = monthBounds(year, m);
    let ad = 0, off = 0;
    for (const r of dailyRows) {
      if (r.channel_grouping !== 'Brand TV Channels') continue;
      if (r.date < start || r.date > end) continue;
      ad += r.spend || 0;
      off += r.offlineSpendReal || 0;
    }
    const sem = ad - off;
    series.push({
      month: m, label: MONTH_NAMES[m],
      SemBrand: sem, Offline: off,
      SemBrandPct: ad ? sem / ad : null,
      OfflinePct: ad ? off / ad : null,
    });
  }
  return series;
}

function monthRatios(m) {
  const spend = m.Spend || 0, leads = m.Leads || 0, sales = m.Sales || 0, cash = m.NewCash || 0;
  const fullcm = m.FullCM || 0, projrevshort = m.ProjRevShort || 0, enrollments = m.TotalEnrollments || 0;
  return {
    ...m,
    CPL: leads ? spend / leads : null,
    CMPS: sales ? spend / sales : null,
    MarginPct: cash ? (cash - spend) / cash : null,
    LtvShort: enrollments ? projrevshort / enrollments : null,
    FullUnitCmShort: enrollments ? fullcm / enrollments : null,
    FullCmPctShort: projrevshort ? fullcm / projrevshort : null,
  };
}

function buildMarketingOrgSplit(dailyRows, mktorgMonthlyRows, year, throughMonth) {
  const byChannel = {};
  for (const chKey of CHANNEL_KEYS) byChannel[chKey] = { juniorOwn: [], overflow: [] };

  for (let m = 1; m <= throughMonth; m++) {
    const { start, end } = monthBounds(year, m);
    const acc = {};
    for (const chKey of CHANNEL_KEYS) acc[chKey] = { juniorOwn: emptyTotals(), overflow: emptyTotals() };

    for (const r of dailyRows) {
      if (r.date < start || r.date > end) continue;
      const chKey = CHANNEL_KEY_MAP[r.channel_grouping];
      if (!chKey) continue;
      const side = r.marketing_organization === 'Open English Junior' ? 'juniorOwn' : 'overflow';
      addDailyRowInto(acc[chKey][side], r);
    }
    for (const r of mktorgMonthlyRows) {
      if (r.year !== year || r.month !== m) continue;
      const chKey = CHANNEL_KEY_MAP[r.channel_grouping];
      if (!chKey) continue;
      const side = r.marketing_organization === 'Open English Junior' ? 'juniorOwn' : 'overflow';
      addKpiRowInto(acc[chKey][side], r);
    }

    for (const chKey of CHANNEL_KEYS) {
      for (const side of ['juniorOwn', 'overflow']) {
        const t = acc[chKey][side];
        byChannel[chKey][side].push(monthRatios({ month: m, label: MONTH_NAMES[m], ...t }));
      }
    }
  }

  function combine(keys, side) {
    const out = [];
    for (let i = 0; i < throughMonth; i++) {
      const summed = { month: i + 1, label: MONTH_NAMES[i + 1] };
      for (const f of ['Spend', 'Leads', 'Sales', 'NewCash', 'FullCM', 'ProjRevShort', 'TotalEnrollments']) {
        summed[f] = keys.reduce((acc2, k) => acc2 + byChannel[k][side][i][f], 0);
      }
      out.push(monthRatios(summed));
    }
    return out;
  }
  const psKeys = ['paidSocialASC', 'paidSocialNoASC', 'socialOrganic'];
  byChannel.paidSocialPlusOrganic = { juniorOwn: combine(psKeys, 'juniorOwn'), overflow: combine(psKeys, 'overflow') };
  byChannel.blended = { juniorOwn: combine(CHANNEL_KEYS, 'juniorOwn'), overflow: combine(CHANNEL_KEYS, 'overflow') };

  return byChannel;
}

const MKTORG_FILTER = { juniorOwn: 'Open English Junior', adultOnly: 'OE' };

function buildActualsByCountryMktOrg(dailyRows, mktorgKpiRows, startDate, endDate, isBrazilDeck) {
  const countries = isBrazilDeck ? ['Brazil'] : LATAM_COUNTRIES;
  const out = {};
  for (const orgKey in MKTORG_FILTER) {
    const orgValue = MKTORG_FILTER[orgKey];
    const byCountry = {};
    for (const r of dailyRows) {
      if (r.channel_grouping !== 'Brand TV Channels') continue;
      if (r.marketing_organization !== orgValue) continue;
      if (r.date < startDate || r.date > endDate) continue;
      const c = bucketCountry(r.country, isBrazilDeck);
      if (c === null) continue;
      const b = byCountry[c] || (byCountry[c] = emptyTotals());
      addDailyRowInto(b, r);
    }
    for (const r of mktorgKpiRows) {
      if (r.marketing_organization !== orgValue) continue;
      if (r.date < startDate || r.date > endDate) continue;
      const c = bucketCountry(r.country, isBrazilDeck);
      if (c === null) continue;
      const b = byCountry[c] || (byCountry[c] = emptyTotals());
      addKpiRowInto(b, r);
    }
    out[orgKey] = {};
    for (const c of countries) out[orgKey][c] = byCountry[c] || emptyTotals();
  }
  return out;
}

function buildYoyByCountryMktOrg(dailyRows, mktorgKpiRows, cutoffDate, isBrazilDeck) {
  const { exactStart, exactEnd, shiftedStart, shiftedEnd } = computeYoyWindows(cutoffDate);
  const countries = isBrazilDeck ? ['Brazil'] : LATAM_COUNTRIES;

  function windowForOrg(orgValue, start, end) {
    const byCountry = {};
    for (const r of dailyRows) {
      if (r.channel_grouping !== 'Brand TV Channels') continue;
      if (r.marketing_organization !== orgValue) continue;
      if (r.date < start || r.date > end) continue;
      const c = bucketCountry(r.country, isBrazilDeck);
      if (c === null) continue;
      const b = byCountry[c] || (byCountry[c] = emptyTotals());
      addDailyRowInto(b, r);
    }
    for (const r of mktorgKpiRows) {
      if (r.marketing_organization !== orgValue) continue;
      if (r.date < start || r.date > end) continue;
      const c = bucketCountry(r.country, isBrazilDeck);
      if (c === null) continue;
      const b = byCountry[c] || (byCountry[c] = emptyTotals());
      addKpiRowInto(b, r);
    }
    const out = {};
    for (const c of countries) out[c] = byCountry[c] || emptyTotals();
    return out;
  }

  const result = {};
  for (const orgKey in MKTORG_FILTER) {
    const orgValue = MKTORG_FILTER[orgKey];
    result[orgKey] = {
      exact: windowForOrg(orgValue, exactStart, exactEnd),
      shifted: windowForOrg(orgValue, shiftedStart, shiftedEnd),
      exactRange: { start: exactStart, end: exactEnd },
      shiftedRange: { start: shiftedStart, end: shiftedEnd },
    };
  }
  return result;
}

function buildMeta(cutoffDate, daysInMonth) {
  const [y, m, d] = cutoffDate.split('-').map(Number);
  return {
    month: `${y}-${String(m).padStart(2, '0')}`,
    asOfDay: d,
    daysInMonth,
    pacing: Math.round((d / daysInMonth) * 10000) / 10000,
  };
}

/**
 * Assembles one deck's full DATA_BY_DECK[deckId] object (all 12 contract keys) from its raw
 * exported rows + the active cutoff date. dailyTrackerBudget only exists for OE (Adult) decks;
 * marketingOrgSplit/actualsByCountryMktOrg/yoyByCountryMktOrg only exist for Junior decks --
 * matches the OLD pipeline's own deck-conditional key presence exactly (see build_data_all.py).
 */
function buildDeckData(raw, deckId, cutoffDate) {
  const isBrazilDeck = deckId === 'OE-BR' || deckId === 'JR-BR';
  const isOE = deckId === 'OE-LATAM' || deckId === 'OE-BR';
  const isJunior = deckId === 'JR-LATAM' || deckId === 'JR-BR';
  const [year, month] = cutoffDate.split('-').map(Number);
  const { start: monthStart } = monthBounds(year, month);
  const daysInMonth = new Date(year, month, 0).getDate();

  const data = {
    meta: buildMeta(cutoffDate, daysInMonth),
    actuals: buildActuals(raw.dailyRows, raw.channelKpiRows, monthStart, cutoffDate, isBrazilDeck),
    budget: buildBudget(raw.budgetRows, monthStart),
    trends: buildTrends(raw.dailyRows, year, month, isBrazilDeck),
    budgetTrends: buildBudgetTrends(raw.budgetRows, year, month),
    yoyByCountry: buildYoyByCountry(raw.dailyRows, raw.channelKpiRows, raw.brandedTypeRows, cutoffDate, isBrazilDeck),
    yoyDailyByCountry: buildYoyDailyByCountry(raw.dailyRows, raw.channelKpiRows, raw.brandedTypeRows, isBrazilDeck),
    spendMixBranded: buildSpendMixBranded(raw.dailyRows, year, month),
  };
  if (isOE) {
    data.dailyTrackerBudget = buildDailyTrackerBudget(raw.dailyTrackerBudgetRows, monthStart, cutoffDate, isBrazilDeck);
  }
  if (isJunior) {
    data.marketingOrgSplit = buildMarketingOrgSplit(raw.dailyRows, raw.mktorgMonthlyKpiRows, year, month);
    data.actualsByCountryMktOrg = buildActualsByCountryMktOrg(raw.dailyRows, raw.mktorgKpiRows, monthStart, cutoffDate, isBrazilDeck);
    data.yoyByCountryMktOrg = buildYoyByCountryMktOrg(raw.dailyRows, raw.mktorgKpiRows, cutoffDate, isBrazilDeck);
  }
  return data;
}

/**
 * TEMPORARY bootstrap for this verification stage only: loads the 4 exported deck JSON files via
 * SYNCHRONOUS XHR (deprecated API, but the only way to keep the rest of template.html's bootstrap
 * -- which assumes DATA_BY_DECK is populated the instant its defining line finishes -- unchanged
 * while this is being verified against the current visual output with zero regression). Once the
 * Google login + real Drive fetch is added (last piece of Phase 2, deliberately deferred), this
 * function goes away and the bootstrap becomes properly async (fetch + await) -- do not build
 * further features on top of the sync assumption this makes.
 */
let _rawByDeckCache = null;

function loadDataByDeckSync(dataDir, cutoffDate) {
  const deckIds = ['OE-LATAM', 'OE-BR', 'JR-LATAM', 'JR-BR'];
  const rawByDeck = {};
  const out = {};
  for (const deckId of deckIds) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `${dataDir}/${deckId}.json`, false);
    xhr.send(null);
    if (xhr.status !== 200 && xhr.status !== 0) {
      throw new Error(`Failed to load ${deckId}.json: HTTP ${xhr.status}`);
    }
    const raw = JSON.parse(xhr.responseText);
    rawByDeck[deckId] = raw;
    out[deckId] = buildDeckData(raw, deckId, cutoffDate);
  }
  _rawByDeckCache = rawByDeck;
  return out;
}

/**
 * Loads all 4 decks via an ASYNC, source-agnostic fetch function (fetchOneFn(deckId) => Promise
 * resolving to that deck's raw JSON object) -- e.g. an authenticated Google Drive fetch, or a
 * plain `fetch()` against a local/CDN path. Populates the same raw-data cache loadDataByDeckSync
 * does, so rebuildDataByDeck()/getAvailableDateRange() work identically afterward regardless of
 * which loader populated it. This is the REAL, permanent loading path (Drive + login) -- the sync
 * XHR loader above is a temporary bridge for the pre-login verification stage only.
 */
async function loadDataByDeckAsync(fetchOneFn, cutoffDate) {
  const deckIds = ['OE-LATAM', 'OE-BR', 'JR-LATAM', 'JR-BR'];
  const rawByDeck = {};
  const out = {};
  for (const deckId of deckIds) {
    const raw = await fetchOneFn(deckId);
    rawByDeck[deckId] = raw;
    out[deckId] = buildDeckData(raw, deckId, cutoffDate);
  }
  _rawByDeckCache = rawByDeck;
  return out;
}

/**
 * Rebuilds DATA_BY_DECK for every deck at a DIFFERENT cutoff date, reusing the already-fetched raw
 * rows (no re-fetch) -- backs the month selector. Throws if called before loadDataByDeckSync (or
 * its future async replacement) has populated the cache once.
 */
function rebuildDataByDeck(cutoffDate) {
  if (!_rawByDeckCache) throw new Error('rebuildDataByDeck: no raw data cached yet');
  const out = {};
  for (const deckId in _rawByDeckCache) {
    out[deckId] = buildDeckData(_rawByDeckCache[deckId], deckId, cutoffDate);
  }
  return out;
}

/** Earliest/latest date any deck's dailyRows actually cover -- used to bound the month-selector's
 * options and the custom-range picker's min/max without hardcoding "2025-01" anywhere twice. */
function getAvailableDateRange() {
  if (!_rawByDeckCache) throw new Error('getAvailableDateRange: no raw data cached yet');
  let min = null, max = null;
  for (const deckId in _rawByDeckCache) {
    for (const r of _rawByDeckCache[deckId].dailyRows) {
      if (min === null || r.date < min) min = r.date;
      if (max === null || r.date > max) max = r.date;
    }
  }
  return { min, max };
}
