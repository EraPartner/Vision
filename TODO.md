# TODO

## Bugs

### General

- ZAKGELD planned payment doesn't seem to be correct anymore
- watching splits crashes (Can't find variable: t) Translation?
- 'splits' word in 'who owes you' page does not take singular/plural into account
- splits.addPerson should not have a + since that is already in the input field
- plannedPayments executed count is not correct for zakgeld (possibly because of recurring)
- spending by category names in statistics' page categories graph don't match the category names when hovering + the listed names have duplicates
- When changing uncategorized transaction in uncategorized view only, the assigned category forces the UI to update and remove the recipient from the list, giving an inconsistency, since the confirmation dialog is still there. Then confirming, gives an error of course but still stores the category well
- toggling filters on some charts in the dashboard (cash flow chart and 6 month trends) causes the chart to disappear

### No translations provided for the following

- splits.created

## Features

- Ship the app through docker (marketplace)?
- make sure split amount is not more than the total amount of the transaction
- in a transaction, show if it has been split or not when trying to split again
- When making a planned payment, make recipient and category clearly searchable
- See history of executed planned payments
- Add filter ignore button for top 10 recipients by spend and remove top recipients by spending since this shows the same recipients all the time and is not useful to show
- Multithreading?
- UML models
