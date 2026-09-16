import { migrate, pool } from './db.ts';

const applied = await migrate();
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema up to date.');
await pool.end();
