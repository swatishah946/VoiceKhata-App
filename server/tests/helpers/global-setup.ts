import { migrate } from '../../scripts/migrate';

/** Runs once before all tests: bring the TEST database schema up to date. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/voicekhata_test';
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error(`Refusing to run tests against "${url}": database name must contain "test"`);
  }
  await migrate(url, () => undefined);
}
