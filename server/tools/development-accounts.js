import { randomBytes } from "node:crypto";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { nearestSavedArrival } from "../../client/src/world/field-arrival.js";

const ACCOUNTS = [
  { name: "admin", legacy: "dev_developer", role: "developer" },
  { name: "player", legacy: "dev_player", role: "player" },
];

/** Development launcher only: stable credentials, preserving legacy characters. */
export async function bootstrapDevelopmentAccounts(
  database,
  content,
  environment,
) {
  const manifest = await content.map(content.catalog.defaultMap);
  const arrival = nearestSavedArrival(manifest, { x: 0, y: 0, facing: 1 });
  const password =
    environment.OPENMS_DEV_PASSWORD ?? randomBytes(16).toString("base64url");
  const passwordHash = await Bun.password.hash(password, {
    algorithm: "argon2id",
  });
  const credentials = [];
  for (const entry of ACCOUNTS) {
    const account = await provisionAccount(database, entry, passwordHash);
    if (!(await database.listCharacters(account.id)).length) {
      const profile = createProfile({
        mapId: manifest.id,
        x: arrival.x,
        y: arrival.y,
        facing: arrival.facing ?? 1,
      });
      profile.name = entry.role === "developer" ? "Developer" : "Player";
      await database.createCharacter(account.id, profile);
    }
    credentials.push({ name: entry.name, password });
  }
  return credentials;
}

async function provisionAccount(database, entry, passwordHash) {
  const { name, legacy, role } = entry;
  const account =
    (await database.accountByName(name)) ??
    (await database.accountByName(legacy));
  if (!account) return database.createAccount({ name, passwordHash, role });
  if (account.role !== role) {
    throw new Error(
      `Refusing to replace unrelated ${account.name} account role`,
    );
  }
  await database.sql`UPDATE account SET name=${name},password_hash=${passwordHash} WHERE id=${account.id}`;
  return account;
}
