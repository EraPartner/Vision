# TODO

## Bugs

### General

- When scrolling through the transactions, it first shows ±300 entries, then it shows the rest. When scrolling down toward entry ±250, it should load the next 300 as well, and so on, so that the user doesn't have to wait for the next 300 entries to load when they scroll down and that not all the entries are loaded at once, which can cause performance issues. The recipient table does this correctly with their 50 recipients, here, you don't notice that the n ext 100 entries are loaded.

### No translations provided for the following

- dashboard.greetingMorning with differential greeting based on the time of day (morning, afternoon, evening)

## Features

- Add the glass card morphism kind of design to the app where pretty/fully add glass-ui by crenspire??
- Add the hovering over stat cards feature of the dashboard to every stat card across the app (also more in the dashboard itself)

- Ship the app through docker (marketplace)?
- Add ability to query database using local AI
