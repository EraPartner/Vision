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

const mapping = {
  "addRec.namePlaceholder": "Naam ontvanger",
  "onboarding.cat.insurance": "Verzekeringen",
  "portfolio.assetGroup.crypto": "Crypto",

  "tax.suggestions.title": "Mogelijke aftrekken / kredieten waarvoor u mogelijk in aanmerking komt",
  "tax.suggestions.none": "Geen duidelijke ontbrekende aftrekposten gevonden. Controleer onderstaande regionale items of open uw belastingprofiel om invoer te bevestigen.",
  "tax.suggestions.pwcLink": "PwC — België: Individueel — Aftrekken",
  "tax.suggestions.estimateNote": "Geschat",
  "tax.suggestions.cta": "Toevoegen / Bewerken",
  "tax.suggestions.regionalTitle": "Regionale items waar u mogelijk voor in aanmerking komt",
  "tax.suggestions.regionalDesc": "Voorbeelden: hypotheekaflossingsvermindering, dienstencheques, beschermingsinvesteringen, renovatie-/onderhoudspremies. Deze zijn regiogebonden en worden niet automatisch op de federale personenbelasting toegepast.",
  "tax.suggestions.multipleResidencesNote": "Als u meerdere eigendommen bezit, toont de portefeuille-belastingpagina voor elk verblijf geschatte regionale onroerendezaakbelastingen; een geaggregeerde schatting staat in de algemene belastingtotaal als informatief.",
  "tax.suggestions.regionalNote": "Regionale aftrekken worden ter referentie vermeld en niet automatisch toegepast op de federale personenbelasting.",

  "tax.suggestions.pension.noAmount": "U markeerde pensioenbijdragen als in aanmerking komend, maar gaf geen bedrag op. PwC: tot €1.050 @30% (standaard) of €1.350 @25% (alternatief).",
  "tax.suggestions.pension.notMarked": "U voerde pensioenbijdragen in maar markeerde ze niet als in aanmerking komend. Markeer ze om de federale vermindering toe te passen.",
  "tax.suggestions.pension.suggest": "Pensioensparen kan een federale belastingvermindering opleveren. Overweeg bij te dragen (PwC-limieten van toepassing).",

  "tax.suggestions.life.noAmount": "U markeerde levensverzekering als in aanmerking komend, maar gaf geen premiebedrag op. PwC-limiet: €2.530 @30%.",
  "tax.suggestions.life.notMarked": "U voerde levensverzekeringspremies in maar markeerde ze niet als in aanmerking komend. Markeer ze om de 30% federale vermindering (tot limiet) toe te passen.",

  "tax.suggestions.group.noAmount": "U markeerde groepsverzekering als in aanmerking komend, maar gaf geen bijdragebedrag op. Werknemersgroepsverzekering komt vaak in aanmerking voor een federale vermindering.",
  "tax.suggestions.group.notMarked": "U voerde groepsverzekeringbijdragen in maar markeerde ze niet als in aanmerking komend. Markeer ze om de federale vermindering (~30%) toe te passen.",
  "tax.suggestions.group.suggest": "Als u werknemer bent, kunnen bijdragen aan groepsverzekering recht geven op een federale vermindering (30%).",

  "tax.suggestions.donations.noAmount": "U markeerde donaties als in aanmerking komend maar gaf geen bedrag op. PwC: 45% vermindering voor kwalificerende donaties (min. €40 aan erkende EER-instellingen).",
  "tax.suggestions.donations.notMarked": "U voerde donaties in maar markeerde ze niet als in aanmerking komend. Markeer ze als kwalificerende donaties om de 45% vermindering toe te passen.",
  "tax.suggestions.donations.note": "45% vermindering voor kwalificerende donaties ≥ €40 aan erkende EER-instellingen (PwC).",

  "tax.suggestions.childcare.noAmount": "U markeerde kinderopvang als in aanmerking komend maar gaf geen kosten op. De vermindering is 45% tot €16,90/dag (2025) per in aanmerking komend kind — geef het aantal dagen op voor een nauwkeurigere limiet.",
  "tax.suggestions.childcare.notMarked": "U voerde kinderopvangkosten in maar markeerde ze niet als in aanmerking komend. Markeer ze om de 45% federale vermindering tot de daglimiet toe te passen.",
  "tax.suggestions.childcare.suggest": "U heeft afhankelijken; kinderopvangkosten kunnen recht geven op een 45% vermindering. Voorbeeld gebruikt: {days} in aanmerking komende dagen.",

  "tax.suggestions.domestic.noAmount": "U markeerde huishoudhulp als in aanmerking komend maar gaf geen kosten op. PwC: 30% vermindering wanneer van toepassing (limieten en voorwaarden variëren).",
  "tax.suggestions.domestic.notMarked": "U voerde huishoudhulpkosten in maar markeerde ze niet als in aanmerking komend. Markeer ze om de 30% vermindering toe te passen.",

  "tax.suggestions.alimony.applied": "Alimentatie wordt als 80% aftrekbaar van het belastbaar inkomen behandeld; geschatte belastingbesparing getoond op basis van uw marginale tarief (indicatief).",
};

let added = 0;
for (const [k, v] of Object.entries(mapping)) {
  if (!en.hasOwnProperty(k)) continue;
  if (nl[k] !== v) {
    nl[k] = v;
    added++;
  }
}

fs.writeFileSync(nlPath, JSON.stringify(nl, null, 2) + '\n', 'utf8');
console.log(`Auto-translate pass2: wrote ${added} translations to i18n/source/nl.json`);
process.exit(0);
