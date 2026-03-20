# TODO

## Bugs

### General

- plannedPayments executed count is not correct for zakgeld (possibly because of recurring)
- spending by category names in statistics' page categories graph don't match the category names when hovering + the listed names have duplicates
- When changing uncategorized transaction in uncategorized view only, the assigned category forces the UI to update and remove the recipient from the list, giving an inconsistency, since the confirmation dialog is still there. Then confirming, gives an error of course but still stores the category well
- toggling filters on some charts in the dashboard (cash flow chart and 6 month trends) causes the chart to disappear
- When settling debts, see both the recipient of split transaction and the memo, not only the memo
- White box over date picker when linking transaction to a planned payment
- in the watchlist, only show either the price or say how much percentage it is above the buy price, not both: 9.21% 9% above target

### No translations provided for the following

## Features

- Add a way to settle all outstanding debts at once in who owes you
- Add a way to see the recent transactions of the relevanat recipient when settling debts
- in a transaction, show if it has been split or not when trying to split again
- make sure split amount is not more than the total amount of the transaction
- When settling debts, allow an export functionality that exports the transactions corresponding to the debt in a csv file with the amount set to the amount that is to be settled
- When making a planned payment, make recipient and category clearly searchable
- Add filter ignore button for top 10 recipients by spend and remove top recipients by spending since this shows the same recipients all the time and is not useful to show
- Make the date picker (especially in linking transaction to planned payment) more nice looking, check other locations too
- When doubleclicking the name of the stock in the watchlist, we use market lookup for that stock and view that
- Change the number of decimals in the watchlist to 2 decimals
- See history of executed planned payments
- Find a way for kinesis yields (free dividends?)
- Add support for metals/foreign exchange as investments
- Ship the app through docker (marketplace)?
- Add ability to query database using local AI
