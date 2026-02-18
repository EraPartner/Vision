// Test the date logic to verify it works correctly
import { differenceInDays } from 'date-fns';

function testDateLogic(todayStr, dueDateStr) {
  // Simulate "today" being set
  const [todayYear, todayMonth, todayDay] = todayStr.split('-').map(Number);
  const normalizedToday = new Date(todayYear, todayMonth - 1, todayDay, 0, 0, 0, 0);
  
  // Parse the due date string (YYYY-MM-DD)
  const [year, month, day] = dueDateStr.split('-').map(Number);
  const normalizedDue = new Date(year, month - 1, day, 0, 0, 0, 0);
  
  // Calculate the difference in days
  const days = differenceInDays(normalizedDue, normalizedToday);
  
  console.log(`Today: ${todayStr} (${normalizedToday.toDateString()})`);
  console.log(`Due: ${dueDateStr} (${normalizedDue.toDateString()})`);
  console.log(`Days difference: ${days}`);
  console.log(`Result: ${
    days === 0 ? 'Today' :
    days < 0 ? 'Overdue' :
    days === 1 ? 'Tomorrow' :
    days <= 7 ? `In ${days}d` :
    'Future'
  }`);
  console.log('---');
  
  return days;
}

console.log('Testing date logic:');
console.log('===================\n');

// Test cases: Today is 2026-02-18 (the 18th)
console.log('Scenario: Today is 2026-02-18 (February 18th, 2026)\n');

testDateLogic('2026-02-18', '2026-02-18'); // Should be "Today" (0 days)
testDateLogic('2026-02-18', '2026-02-19'); // Should be "Tomorrow" (1 day)
testDateLogic('2026-02-18', '2026-02-20'); // Should be "In 2d" (2 days)
testDateLogic('2026-02-18', '2026-02-21'); // Should be "In 3d" (3 days)
testDateLogic('2026-02-18', '2026-02-17'); // Should be "Overdue" (-1 day)
testDateLogic('2026-02-18', '2026-02-16'); // Should be "Overdue" (-2 days);

console.log('\nTest completed!');
