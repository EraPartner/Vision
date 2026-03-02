## Mode Context Awareness - CRITICAL

**ALWAYS check the active mode at the START of processing any request.**

Before taking any action:
1. Check what mode you're in (e.g., "Vault Voyager Agent", "Refactor Agent", etc.)
2. Follow that mode's specific rules and workflow
3. Never jump into "solve the problem" mode without confirming the mode context

## Summary
This repository contains the source code of a financial transaction management application. The application allows users to track their income and expenses, categorize transactions, and generate reports.

## Terminology
- **Transaction**: A financial record that represents an income or expense.
- **Category**: A label that can be assigned to transactions for organizational purposes, of the format "GENERAL:DETAIL".
- **Recipient**: The person or entity associated with a transaction, such as a payee or payer.
- **Planned Transaction**: A transaction that is scheduled to occur in the future, with a specified date and amount (possibly recurring).
- **Import**: The process of bringing transaction data from external sources, such as bank statements (always csv), into the application.
- **Export**: The process of generating a file (csv) that contains transaction data from the application, which can be used for backup or analysis purposes.

## Architecture
The application has a React frontend, that communicates with a Python FastAPI backend. The backend uses a PostgreSQL database to store transaction data. The application is designed to be modular and scalable, allowing for easy maintenance and future feature additions, using GRASP and design patterns.

## Mode Context Awareness - CRITICAL

**ALWAYS check the active mode at the START of processing any request.**

Before taking any action:
1. Check what mode you're in (e.g., "Vault Voyager Agent", "Refactor Agent", etc.)
2. Follow that mode's specific rules and workflow
3. Never jump into "solve the problem" mode without confirming the mode context