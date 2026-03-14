#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const srcDir = path.join('i18n', 'source');
const enPath = path.join(srcDir, 'en.json');
const nlPath = path.join(srcDir, 'nl.json');

if (!fs.existsSync(enPath) || !fs.existsSync(nlPath)) {
  console.error('Ensure i18n/source/en.json and nl.json exist');
  process.exit(1);
}

const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));
const nl = JSON.parse(fs.readFileSync(nlPath, 'utf8'));

// Manual translation map for keys that were missing or still in English.
const translations = {
  "addRec.namePlaceholder": "Naam ontvanger",
  "onboarding.cat.insurance": "Verzekeringen",
  "portfolio.assetGroup.crypto": "Crypto",
  "tax.suggestions.title": "Belastingsuggesties",
  "tax.suggestions.none": "Geen suggesties",
  "tax.suggestions.pwcLink": "Lees meer bij PwC",
  "tax.suggestions.estimateNote": "Let op: dit is een schatting.",
  "tax.suggestions.cta": "Bekijk aanbevelingen",
  "tax.suggestions.regionalTitle": "Regionale onroerendezaakbelasting",
  "tax.suggestions.regionalDesc": "Schatting op basis van uw geselecteerde regio.",
  "tax.suggestions.multipleResidencesNote": "Meerdere verblijven gevonden; gebruik de juiste verblijfsplaats voor nauwkeurige schattingen.",
  "tax.suggestions.regionalNote": "Regionale heffingen kunnen afwijken; controleer lokale regels.",
  "tax.suggestions.pension.noAmount": "Pensioenbedrag niet opgegeven",
  "tax.suggestions.pension.notMarked": "Pensioenen niet gemarkeerd",
  "tax.suggestions.pension.suggest": "Overweeg pensioenvrijstellingen",
  "tax.suggestions.life.noAmount": "Bedrag levensverzekering niet opgegeven",
  "tax.suggestions.life.notMarked": "Levensverzekeringen niet gemarkeerd",
  "tax.suggestions.group.noAmount": "Bedrag groepsregeling niet opgegeven",
  "tax.suggestions.group.notMarked": "Groepsregelingen niet gemarkeerd",
  "tax.suggestions.group.suggest": "Controleer groepsregelingen voor mogelijke belastingvoordelen",
  "tax.suggestions.donations.noAmount": "Donatiebedrag niet opgegeven",
  "tax.suggestions.donations.notMarked": "Donaties niet gemarkeerd",
  "tax.suggestions.donations.note": "Donaties kunnen fiscaal aftrekbaar zijn; bewaar kwitanties.",
  "tax.suggestions.childcare.noAmount": "Kinderopvangkosten niet opgegeven",
  "tax.suggestions.childcare.notMarked": "Kinderopvangkosten niet gemarkeerd",
  "tax.suggestions.childcare.suggest": "Controleer kinderopvangtoeslag of aftrekmogelijkheden",
  "tax.suggestions.domestic.noAmount": "Bedrag huishoudelijke hulp niet opgegeven",
  "tax.suggestions.domestic.notMarked": "Huishoudelijke hulp niet gemarkeerd",
  "tax.suggestions.alimony.applied": "Alimentatie toegepast",

  // Ensure the remaining missing keys are covered with natural Dutch phrasing
  "onboarding.cat.insurance": "Verzekeringen",
  "addRec.namePlaceholder": "Naam ontvanger",
  "portfolio.assetGroup.crypto": "Crypto",
  "tax.suggestions.title": "Belastingsuggesties",
  "tax.suggestions.none": "Geen suggesties",
  "tax.suggestions.pwcLink": "Meer info (PwC)",
  "tax.suggestions.estimateNote": "Geschat",
  "tax.suggestions.cta": "Toevoegen / Bewerken",
  "tax.suggestions.regionalTitle": "Regionale items",
  "tax.suggestions.regionalDesc": "Voorbeelden: hypotheekrenteaftrek, renovatiepremies — regionaal afhankelijk.",
  "tax.suggestions.multipleResidencesNote": "Meerdere eigendommen gevonden; gebruik per verblijf de juiste gegevens voor nauwkeurige schattingen.",
  "tax.suggestions.regionalNote": "Regionale aftrekken worden ter referentie vermeld en niet automatisch toegepast.",
  "tax.suggestions.pension.noAmount": "Geen pensioenbedrag opgegeven",
  "tax.suggestions.pension.notMarked": "Pensioenbijdragen niet gemarkeerd als in aanmerking komend",
  "tax.suggestions.pension.suggest": "Pensioenbijdragen kunnen een federale fiscale vermindering opleveren",
  "tax.suggestions.life.noAmount": "Geen premie voor levensverzekering opgegeven",
  "tax.suggestions.life.notMarked": "Levensverzekeringspremies niet gemarkeerd",
  "tax.suggestions.group.noAmount": "Geen bedrag voor groepsverzekering opgegeven",
  "tax.suggestions.group.notMarked": "Groepsverzekering niet gemarkeerd",
  "tax.suggestions.group.suggest": "Controleer groepsverzekeringen voor mogelijke fiscale voordelen",
  "tax.suggestions.donations.noAmount": "Geen donatiebedrag opgegeven",
  "tax.suggestions.donations.notMarked": "Donaties niet gemarkeerd als aftrekbaar",
  "tax.suggestions.donations.note": "Donaties kunnen aftrekbaar zijn; bewaar kwitanties voor bewijs.",
  "tax.suggestions.childcare.noAmount": "Geen kinderopvangkosten opgegeven",
  "tax.suggestions.childcare.notMarked": "Kinderopvangkosten niet gemarkeerd",
  "tax.suggestions.childcare.suggest": "Kinderopvangkosten kunnen in aanmerking komen voor een fiscale vermindering",
  "tax.suggestions.domestic.noAmount": "Geen kosten huishoudelijke hulp opgegeven",
  "tax.suggestions.domestic.notMarked": "Huishoudelijke hulp niet gemarkeerd",
  "tax.suggestions.alimony.applied": "Alimentatie verwerkt",

  // From the "same as English" set — provide natural Dutch equivalents
  "common.ok": "OK",
  "app.openDockerSite": "Open docker.com",
  "app.openDockerApp": "Open Docker Desktop",
  "update.later": "Later",
  "nav.dashboard": "Dashboard",
  "nav.portfolio": "Portefeuille",
  "nav.crypto": "Crypto",
  "settings.tab.dashboard": "Dashboard",
  "settings.tab.app": "App",
  "settings.general.lang.nl": "Nederlands",
  "dashboard.title": "Dashboard",
  "transactions.bank": "Bank",
  "transactions.filter": "Filter",
  "transactions.info": "Info",
  "transactions.typeFilter": "Type",
  "statistics.trends": "Trends",
  "statistics.percentage": "Percentage",
  "notifications.later": "Later",
  "common.filter": "Filter",
  "common.status": "Status",
  "common.type": "Type",
  "form.addTransaction.type": "Type",
  "form.addTransaction.bank": "Bank",
  "form.addCategory.detail": "Detail",
  "table.items": "{count} items",
  "table.filterLabel": "Filter: {header}",
  "widgets.button": "Widgets",
  "crypto.title": "Cryptovaluta",
  "performance.ytd": "YTD",
  "performance.crypto": "Crypto",
  "exchangeRates.col.eurToUnit": "1 EUR →",
  "transactions.createFailedTitle": "Aanmaken transactie mislukt",
  "transactions.updateFailedTitle": "Bijwerken transactie mislukt",
  "transactions.deleteFailedTitle": "Verwijderen transactie mislukt",
  "recipients.createFailedTitle": "Aanmaken ontvanger mislukt",
  "recipients.updateFailedTitle": "Bijwerken ontvanger mislukt",
  "recipients.deleteFailedTitle": "Verwijderen ontvanger mislukt",
  "recipients.mergeFailedTitle": "Samenvoegen ontvangers mislukt",
  "recipients.unmergeFailedTitle": "Ongedaan maken samenvoeging mislukt",
  "categories.createFailedTitle": "Aanmaken categorie mislukt",
  "categories.updateFailedTitle": "Bijwerken categorie mislukt",
  "categories.deleteFailedTitle": "Verwijderen categorie mislukt",
  "portfolio.createInvestmentFailedTitle": "Aanmaken belegging mislukt",
  "portfolio.updateInvestmentFailedTitle": "Bijwerken belegging mislukt",
  "portfolio.deleteInvestmentFailedTitle": "Verwijderen belegging mislukt",
  "portfolio.recordTxnFailedTitle": "Registreren portefeuilletransactie mislukt",
  "portfolio.deleteTxnFailedTitle": "Verwijderen portefeuilletransactie mislukt",
  "portfolio.refreshPricesFailedTitle": "Koersen verversen mislukt",
  "marketLookup.volume": "Volume",
  "market.fundamentals": "Kerncijfers",
  "market.open": "Openen",
  "market.volume": "Volume",
  "notFound.title": "404",
  "addCat.detail": "Detail",
  "onboarding.cat.restaurants": "Restaurants",
  "onboarding.cat.freelance": "Freelance",
  "onboarding.feature.portfolio.title": "Portfoliobeheer",
  "insights.col.number": "Aantal",
  "addInv.placeholder.jsonEndpoint": "JSON-endpoint (URL)",
  "addPortTxn.type": "Type",
  "addPortTxn.interval": "Interval",
  "invDetail.trigger": "Trigger",
  "addWatchlist.etf": "ETF",
  "addWatchlist.crypto": "Crypto",
  "txPage.col.info": "Info",
  "txPage.col.status": "Status",
  "txPage.field.id": "ID",
  "txPage.field.status": "Status",
  "importPage.sep.tab": "Tab",
  "importPage.sep.pipe": "Pijp",
  "recipientsPage.col.status": "Status",
  "plannedPage.col.status": "Status",
  "portfolio.assetClass.etf": "ETF",
  "portfolio.assetClass.crypto": "Crypto",
  "portfolio.txnType.dividend": "Dividend",
  "common.kb": "Kennisbank",
  "addTxn.currencyPlaceholder": "Valuta",
  "tax.informational": "Informatief",
  "tax.pit.table.component": "Tabelcomponent",
  "tax.chart.pit": "PIT-grafiek",
};

let changed = 0;
for (const [k, v] of Object.entries(translations)) {
  if (!en.hasOwnProperty(k)) continue; // skip keys that don't exist in en master
  if (nl[k] !== v) {
    nl[k] = v;
    changed++;
  }
}

fs.writeFileSync(nlPath, JSON.stringify(nl, null, 2) + '\n', 'utf8');
console.log(`Applied ${changed} auto-translations to i18n/source/nl.json`);
process.exit(0);
