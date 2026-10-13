import Foundation

// Reuses the existing synthetic Tax computation/dashboard fixtures; no live financial data.
enum NativeTaxPrintFixtures {
    static let overview = #"""
            {
              "year": 2025,
              "liveYear": 2025,
              "isHistorical": false,
              "hasSnapshot": true,
              "hasProfile": true,
              "household": {
                "version": 2,
                "taxYear": 2025,
                "profileConfigured": true,
                "region": "flanders",
                "communalSurchargePercent": 7,
                "partners": [
                  {
                    "id": "A",
                    "isDisabled": false,
                    "activities": [
                      {
                        "id": "act_A_1",
                        "kind": "employee",
                        "grossIncome": 50000
                      }
                    ],
                    "professionalExpenses": {},
                    "unionDues": 0,
                    "otherTaxableIncome": 0,
                    "alimonyPaid": 0,
                    "reductions": {
                      "personalPensionContributions": 0,
                      "lifeInsurancePremiums": 0,
                      "charitableDonations": 0,
                      "childcareCosts": 0,
                      "medicalExpenses": 0
                    }
                  }
                ],
                "relationship": {
                  "events": []
                },
                "dependents": {
                  "children": 0,
                  "otherPersons": 0
                },
                "home": {
                  "cadastralIncome": 0,
                  "mortgageInterestPaid": 0
                }
              },
              "liveHousehold": {
                "version": 2,
                "taxYear": 2025,
                "profileConfigured": true,
                "region": "flanders",
                "communalSurchargePercent": 7,
                "partners": [
                  {
                    "id": "A",
                    "isDisabled": false,
                    "activities": [
                      {
                        "id": "act_A_1",
                        "kind": "employee",
                        "grossIncome": 50000
                      }
                    ],
                    "professionalExpenses": {},
                    "unionDues": 0,
                    "otherTaxableIncome": 0,
                    "alimonyPaid": 0,
                    "reductions": {
                      "personalPensionContributions": 0,
                      "lifeInsurancePremiums": 0,
                      "charitableDonations": 0,
                      "childcareCosts": 0,
                      "medicalExpenses": 0
                    }
                  }
                ],
                "relationship": {
                  "events": []
                },
                "dependents": {
                  "children": 0,
                  "otherPersons": 0
                },
                "home": {
                  "cadastralIncome": 0,
                  "mortgageInterestPaid": 0
                }
              },
              "householdSnapshots": {},
              "snapshotMetas": {},
              "metadata": {
                "frozenCalculation": {
                  "totalPIT": 123.4567
                }
              },
              "calculation": {
                "totalPIT": 123.4567
              },
              "result": {
                "engineVersion": 2,
                "incomeYear": 2025,
                "assessment": {
                  "mode": "single",
                  "reason": "one_partner",
                  "legalBasis": "WIB 92 art. 126 \u00a71",
                  "partnerIds": [
                    "A"
                  ]
                },
                "partners": [
                  {
                    "partnerId": "A",
                    "activities": [
                      {
                        "activityId": "act_A_1",
                        "kind": "employee",
                        "forfaitCategory": "remuneration",
                        "grossIncome": 50000,
                        "employeeSocialSecurity": 6535.000000000001,
                        "socialContributionsPaid": 0,
                        "professionalExpenses": 5930,
                        "netProfessionalIncome": 37535
                      }
                    ],
                    "categories": [
                      {
                        "category": "remuneration",
                        "method": "lump_sum",
                        "grossAfterContributions": 43465,
                        "professionalExpenses": 5930,
                        "unionDuesApplied": 0,
                        "netIncome": 37535
                      }
                    ],
                    "grossIncome": 50000,
                    "employeeSocialSecurity": 6535.000000000001,
                    "professionalExpenses": 5930,
                    "unionDuesApplied": 0,
                    "netProfessionalIncome": 37535,
                    "otherTaxableIncome": 0,
                    "alimonyDeduction": 0,
                    "taxableIncomeBeforeQuotient": 37535,
                    "quotientAdjustment": 0,
                    "taxableIncome": 37535,
                    "bracketTax": {
                      "b1": 4080,
                      "b2": 4992,
                      "b3": 3930.75,
                      "b4": 0,
                      "total": 13002.75
                    },
                    "exemption": {
                      "basic": 10910,
                      "disability": 0,
                      "dependentSupplements": 0,
                      "isolatedParentSupplement": 0,
                      "ownTotal": 10910,
                      "transferredIn": 0,
                      "transferredOut": 0,
                      "total": 10910,
                      "applied": 10910
                    },
                    "exemptionBenefit": 2727.5,
                    "pitAfterExemption": 10275.25,
                    "reductions": {
                      "pension": 0,
                      "lifeInsurance": 0,
                      "groupInsurance": 0,
                      "donations": 0,
                      "childcare": 0,
                      "domesticHelp": 0,
                      "serviceVouchers": 0,
                      "total": 0
                    },
                    "ownHomeCreditRegime": "none",
                    "ownHomeCredit": 0,
                    "pensionReduction": 0,
                    "reductionsApplied": 0,
                    "federalPITAfterReductions": 10275.25,
                    "communalSurcharge": 719.2675,
                    "totalPIT": 10994.5175,
                    "specialSocialSecurityContribution": 343.15719,
                    "csssSubject": true,
                    "dividendWhtReclaim": 0,
                    "savingsInterestTax": 0,
                    "marginalRate": 45
                  }
                ],
                "quotient": {
                  "applied": false,
                  "transfer": 0,
                  "target": 0,
                  "cap": 13460,
                  "benefit": 0
                },
                "csss": {
                  "scale": "single",
                  "base": 37535,
                  "total": 343.15719
                },
                "propertyTaxEstimate": 0,
                "totals": {
                  "grossIncome": 50000,
                  "employeeSocialSecurity": 6535.000000000001,
                  "professionalExpenses": 5930,
                  "netProfessionalIncome": 37535,
                  "taxableIncome": 37535,
                  "federalPITBeforeExemption": 13002.75,
                  "personalExemptionBenefit": 2727.5,
                  "taxReductions": 2727.5,
                  "federalPITAfterReductions": 10275.25,
                  "communalSurcharge": 719.2675,
                  "totalPIT": 10994.5175,
                  "specialSocialSecurityContribution": 343.15719,
                  "propertyTaxEstimate": 0,
                  "totalTaxBurden": 17872.674690000003,
                  "netTakeHome": 32127.325309999997,
                  "dividendWhtReclaim": 0,
                  "savingsInterestTax": 0,
                  "refundableChildCredit": 0
                },
                "issues": []
              },
              "calculationSource": "frozen",
              "householdResultSource": "computed",
              "householdMigrationNeeded": false,
              "snapshotsMigrationNeeded": false,
              "storedValueInvalid": false,
              "warnings": [],
              "records": []
            }
        """#
    static let dashboard = #"""
            
                    {"year":2025,"currency":"EUR","isHistorical":false,"hasIncomeSources":true,"hasStatsData":true,"isEmpty":false,
                     "portfolioTaxesForYear":123456789012345.67,"totalTaxIncludingPortfolio":123456789012345.89,"totalTaxIncludingPropertyEstimate":null,
                     "yearlyIncome":[{"year":"2025","income":0.1234567890123456789,"estimatedTax":0.02,"netAfterTax":0.1034567890123456789,"isApproximated":false}],
                     "monthlyIncomeTax":[{"period":"2025-01","income":5000,"estimatedTax":200}],"recordedIncomeByPartner":{"A":3500,"B":1500},
                     "yearCalculations":[{"year":2025,"calculation":{"totalPIT":0.02},"isFiled":true,"hasFrozenCalculation":true,"isCurrent":true,"hasSnapshot":true,"hasTransactions":true}],
                     "currentInputs":{"employmentType":"employee","grossAnnualIncome":5000,"otherTaxableIncome":0,"professionalExpenseMethod":"lump_sum","actualProfessionalExpenses":0,"dependentChildren":0,"dependentOtherPersons":0,"isDisabled":false,"isSpouseDisabled":false},
                     "exportProfile":{"taxYear":2025,"grossAnnualIncome":0.1234567890123456789},"suggestions":[],"householdBreakdownRows":[],"rules":[]}
                    
        """#
}
