/**
 * ZOD HELPERS shared by every schema that checks a model's answer.
 */

import { z } from "zod";

/** A string with something in it once trimmed. */
export const nonEmpty = z.string().trim().min(1);

/**
 * A compile-time proof that A is assignable to B.
 *
 * Each schema mirrors a response interface the code declares: the code owns the
 * shape, the schema owns the checking. `Assignable` fails to instantiate unless
 * the parsed type really fits the interface, so an alias of it beside a schema
 * turns drift between the two into a compile error rather than a runtime
 * surprise in the middle of an expensive generation run. Erased after.
 */
export type Assignable<A extends B, B> = [A, B];
