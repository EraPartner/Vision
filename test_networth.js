import { query } from './apps/node-backend/src/database/connection.js';
import { infoRepository } from './apps/node-backend/src/repositories/infoRepository.js';

async function run() {
  try {
    const nw = await infoRepository.getNetWorth('EUR');
    const last2 = nw.snapshots.slice(-2);
    console.log("Last two snapshots:", last2);
    
    // Let's get the components of the last day's difference
    console.log("Current portfolio total:", nw.current.investments);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
