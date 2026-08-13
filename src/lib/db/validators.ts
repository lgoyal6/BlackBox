import type { CollectionInfo, Document } from "mongodb";
import { DECISIONS } from "@/lib/contracts";
import { col, getDb } from "@/lib/db/client";

/** $jsonSchema validator enforcing Critical Rule 4 at the database level. */
export const DECISIONS_VALIDATOR: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["incidentId", "actionChosen", "rationale", "t"],
    properties: {
      incidentId: { bsonType: "string", minLength: 1 },
      actionChosen: { bsonType: "string", minLength: 1 },
      rationale: { bsonType: "string", minLength: 1 },
      t: { bsonType: "date" },
    },
  },
};

export interface ValidatorReport {
  collection: string;
  action: "created" | "collmod" | "unchanged";
}

const VALIDATION_ACTION = "error";
const VALIDATION_LEVEL = "strict";

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function validatorMatches(options: Document | undefined): boolean {
  if (!options) return false;
  return (
    stable(options.validator) === stable(DECISIONS_VALIDATOR) &&
    options.validationAction === VALIDATION_ACTION &&
    options.validationLevel === VALIDATION_LEVEL
  );
}

/** Creates the collection with its validator, or applies it via collMod if it exists. */
export async function applyValidators(): Promise<ValidatorReport[]> {
  const db = getDb();
  const listed = await db.listCollections({ name: DECISIONS }).toArray();
  const existing = listed[0] as CollectionInfo | undefined;

  if (!existing) {
    await db.createCollection(DECISIONS, {
      validator: DECISIONS_VALIDATOR,
      validationAction: VALIDATION_ACTION,
      validationLevel: VALIDATION_LEVEL,
    });
    return [{ collection: DECISIONS, action: "created" }];
  }

  if (validatorMatches(existing.options)) {
    return [{ collection: DECISIONS, action: "unchanged" }];
  }

  const count = await col(DECISIONS).countDocuments();
  if (count === 0) {
    // Atlas readWrite can dropCollection + createCollection, but not collMod.
    await db.dropCollection(DECISIONS);
    await db.createCollection(DECISIONS, {
      validator: DECISIONS_VALIDATOR,
      validationAction: VALIDATION_ACTION,
      validationLevel: VALIDATION_LEVEL,
    });
    return [{ collection: DECISIONS, action: "created" }];
  }

  try {
    await db.command({
      collMod: DECISIONS,
      validator: DECISIONS_VALIDATOR,
      validationAction: VALIDATION_ACTION,
      validationLevel: VALIDATION_LEVEL,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot apply the decisions validator: collMod was denied and ${DECISIONS} has ${count} documents. ` +
        `Grant collMod (dbAdmin) or empty the collection. ${message}`,
    );
  }
  return [{ collection: DECISIONS, action: "collmod" }];
}
