import { execSync } from 'child_process';

console.log('Running database reset (migrate + seed)...');
try {
  execSync('npm run migrate', { stdio: 'inherit' });
  execSync('npm run seed', { stdio: 'inherit' });
  console.log('Database reset complete!');
} catch (err) {
  console.error('Database reset failed:', err);
  process.exit(1);
}
