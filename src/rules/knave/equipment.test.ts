import { describe, expect, it } from "vitest";
import { Rng } from "../../generation/content/blueprint.ts";
import {
  EQUIPMENT_KEYS,
  STANDARD_EQUIPMENT,
  STOCK_STATE,
  amountCount,
  armorFacts,
  equipment,
  equipmentName,
  mintItem,
  mintSpellbook,
  mintTemplate,
  weaponFacts,
  type ItemTemplate,
} from "./equipment.ts";
import {
  ARMOR_KEYS,
  DUNGEONEERING_GEAR,
  GENERAL_GEAR_1,
  GENERAL_GEAR_2,
  SHOP_SECTIONS,
  SPELLS,
  STARTING_RATIONS,
  WEAPONS,
  WEAPON_CLASSES,
} from "./tables.ts";
import { canConsult, isArmor, isBook, isSpellbook, isWeapon, needsComposition } from "../../shared/world/entities.ts";
import { BOOK_SUBJECTS } from "../../generation/content/blueprint.ts";

const rng = () => new Rng(20260818);

// ===========================================================================
// THE TABLE
// ===========================================================================

describe("the standard equipment table", () => {
  it("mints something legal from every single entry", () => {
    for (const key of EQUIPMENT_KEYS) {
      // A spellbook is minted through its own door, since only the caller knows
      // the spell. Every other entry has to stand up on its own.
      if (equipment(key).itemKind === "spellbook") continue;
      const it = mintItem(key, "somewhere", rng());
      expect(it.id, key).toBeTruthy();
      expect(it.type, key).toBe("Item");
      expect(it.name, key).toBeTruthy();
      expect(it.slots, key).toBeGreaterThanOrEqual(0);
      expect(it.value, key).toBeGreaterThanOrEqual(0);
      expect(it.parentId, key).toBe("somewhere");
    }
  });

  it("says what kind of thing it is, or is plain gear and says nothing", () => {
    for (const key of EQUIPMENT_KEYS) {
      const t: ItemTemplate = equipment(key);
      if (t.itemKind === "weapon") expect(weaponFacts(key), key).toBeDefined();
      if (t.itemKind === "armor") expect(armorFacts(key), key).toBeDefined();
    }
  });

  /**
   * The reason the table exists. Knave prints rope on two pages; if the merge
   * missed one, two entries would carry the same label and the second would be
   * the one nobody maintains.
   */
  it("holds each real thing exactly once", () => {
    const labels = EQUIPMENT_KEYS.map(equipmentName);
    expect(new Set(labels).size, labels.join(" · ")).toBe(labels.length);
  });

  it("names armor and weapons the picker expects, and prices them once", () => {
    for (const key of ARMOR_KEYS) expect(armorFacts(key), key).toBeDefined();
    for (const key of WEAPONS) expect(weaponFacts(key), key).toBeDefined();
    // The shop and character creation read this one number. There is no second.
    expect(equipment("gambeson").value).toBe(60);
    expect(equipment("crossbow").value).toBe(60);
  });

  it("gives the gear tables twenty real keys each", () => {
    for (const table of [DUNGEONEERING_GEAR, GENERAL_GEAR_1, GENERAL_GEAR_2]) {
      expect(table).toHaveLength(20);
      for (const row of table) {
        expect(STANDARD_EQUIPMENT[row.key], row.key).toBeDefined();
        // An override is there to say the gear table's quantity differs. One
        // that matches the entry is an override nobody needed.
        if (row.amount !== undefined) expect(row.amount, row.key).not.toBe(equipment(row.key).amount);
        if (row.value !== undefined) expect(row.value, row.key).toBeGreaterThan(0);
      }
    }
  });

  it("sells only keys that exist, each in one section", () => {
    const sold = SHOP_SECTIONS.flatMap((s) => s.entries);
    expect(new Set(sold).size).toBe(sold.length);
    for (const key of sold) expect(STANDARD_EQUIPMENT[key], key).toBeDefined();
  });

  it("keeps the free two days of rations pointing at the rations entry", () => {
    expect(STARTING_RATIONS.key).toBe("rations");
    expect(mintItem(STARTING_RATIONS.key, "", rng(), STARTING_RATIONS).amount).toBe("2 days");
  });
});

// ===========================================================================
// MINTING
// ===========================================================================

describe("minting", () => {
  it("hands out a fresh object every time", () => {
    const a = mintItem("torch", "pc", rng());
    const b = mintItem("torch", "pc", rng());
    expect(a.id).not.toBe(b.id);
    expect(a).not.toBe(b);
    expect(a.name).toBe("Torch");
  });

  it("starts quality at full, and leaves it off things that have none", () => {
    const gambeson = mintItem("gambeson", "pc", rng());
    expect(gambeson.quality).toBe(3);
    expect(gambeson.currentQuality).toBe(3);
    expect(mintItem("rope", "pc", rng()).quality).toBeUndefined();
  });

  it("takes the quantity and price a gear table prints over the shop's", () => {
    const shopTorch = mintItem("torch", "pc", rng());
    const rolledTorches = mintItem("torch", "pc", rng(), { amount: "5", value: 5 });
    expect(shopTorch.amount).toBe("1 hour");
    expect(shopTorch.value).toBe(1);
    expect(rolledTorches.amount).toBe("5");
    expect(rolledTorches.value).toBe(5);
  });

  it("carries the weapon and armor facts through onto the item", () => {
    const sword = mintItem("sword", "pc", rng());
    expect(isWeapon(sword) && sword.weapon).toEqual({ damage: "1d8", hands: 1 });
    const shield = mintItem("shield", "pc", rng());
    expect(isArmor(shield) && shield.armor).toEqual({ armorType: "shield", defense: 1 });
  });

  /**
   * The whole point of writing the prose into the table: a bought gambeson
   * arrives described, so no composition pass ever spends a call on one.
   */
  it("arrives described when the entry is written, and owes nothing after", () => {
    const written: ItemTemplate = {
      name: "Gambeson",
      value: 60,
      base: "A quilted coat of layered linen.",
      state: "Newly bought, and stiff with it.",
      composed: "",
    };
    const it = mintTemplate(written, "pc", rng());
    expect(it.base).toBe(written.base);
    expect(it.state).toBe(written.state);
    // composed falls back to base, which is what settles the debt.
    expect(it.composed).toBe(written.base);
    expect(needsComposition(it)).toBe(false);
  });

  it("gives a written entry with no state of its own the stock one", () => {
    const it = mintTemplate(
      { name: "Rope", amount: "50 feet", value: 10, base: "Fifty feet of hemp rope." },
      "pc",
      rng()
    );
    expect(it.state).toBe(STOCK_STATE);
  });

  /**
   * An unfilled entry mints what it always did — which is what makes writing
   * the prose in a thing that can be done one entry at a time, rather than a
   * hundred and twenty before anything works.
   */
  it("leaves an unwritten entry prose-less and still owing a description", () => {
    const it = mintTemplate({ name: "Bucket", value: 5, base: "", state: "", composed: "" }, "pc", rng());
    expect(it.base).toBeUndefined();
    expect(it.state).toBeUndefined();
    expect(it.composed).toBeUndefined();
    expect(needsComposition(it)).toBe(true);
  });
});

// ===========================================================================
// BOOKS AND SPELLBOOKS
// ===========================================================================

describe("books", () => {
  /**
   * How much is in a book is NOT decided when the book is made. It starts
   * unread, and how deep it goes is found out by reading it — see consultRoll.
   */
  it("arrives unread, whatever the seed", () => {
    for (let seed = 0; seed < 50; seed++) {
      const book = mintItem("reading_book", "pc", new Rng(seed));
      expect(isBook(book)).toBe(true);
      if (!isBook(book)) continue;
      expect(book.book.uses, `seed ${seed}`).toBe(0);
      expect(book.book.exhausted, `seed ${seed}`).toBeUndefined();
      expect(canConsult(book), `seed ${seed}`).toBe(true);
    }
  });

  it("rolls its subject off the Maze Rats table", () => {
    const book = mintItem("reading_book", "pc", rng());
    expect(isBook(book) && BOOK_SUBJECTS).toContain(isBook(book) ? book.book.subject : "");
  });

  it("is the same book twice for the same seed", () => {
    const a = mintItem("reading_book", "pc", new Rng(7));
    const b = mintItem("reading_book", "pc", new Rng(7));
    expect(isBook(a) && a.book).toEqual(isBook(b) && b.book);
  });

  it("takes a pinned subject instead of rolling one", () => {
    const book = mintTemplate(
      { name: "Herbal", value: 600, itemKind: "book", book: { subject: "Herbs" } },
      "pc"
    );
    expect(isBook(book) && book.book.subject).toBe("Herbs");
  });

  it("refuses to be minted without a stream to roll its subject from", () => {
    expect(() => mintItem("reading_book", "pc")).toThrow(/Rng/);
  });

  it("will not mint a spellbook without the spell", () => {
    expect(() => mintItem("spellbook", "pc", rng())).toThrow(/mintSpellbook/);
  });
});

describe("spellbooks", () => {
  it("takes its name and its whole content from the spell", () => {
    const spell = SPELLS[0];
    const book = mintSpellbook(spell, "pc");
    expect(isSpellbook(book)).toBe(true);
    expect(book.name).toBe(`Spellbook: ${spell.name}`);
    expect(book.spellBook.spellDescription).toBe(spell.effect);
    expect(book.spellBook.exhausted).toBe(false);
    expect(book.slots).toBe(1);
  });
});

// ===========================================================================
// ONE TABLE, TWO READERS
// ===========================================================================

describe("the shop and character creation", () => {
  it("read the same entry for a weapon class, whichever way in", () => {
    for (const c of WEAPON_CLASSES) {
      for (const key of c.members) {
        const minted = mintItem(key, "pc", rng());
        expect(minted.value, key).toBe(equipment(key).value);
        expect(minted.slots, key).toBe(equipment(key).slots ?? 1);
      }
    }
  });
});

// ===========================================================================
// HOW MUCH IS LEFT
// ===========================================================================
//
// `amount` is prose, and the only question anything asks of it is whether the
// thing has run out. The distinction that matters is NOTHING against ZERO: an
// unparseable amount must survive being written, because the caller deletes the
// item on a zero and "a handful" is not one.

describe("amountCount", () => {
  it("reads the leading integer", () => {
    for (const [amount, n] of [
      ["2 days", 2],
      ["6 doses", 6],
      ["50 feet", 50],
      ["20", 20],
      ["0 days", 0],
      ["  3 pieces  ", 3],
    ] as const) {
      expect(amountCount(amount), amount).toBe(n);
    }
  });

  it("is undefined for anything with no number at the front of it", () => {
    for (const amount of ["a handful", "whole", "capacity 20", "some", "", "  "]) {
      expect(amountCount(amount), JSON.stringify(amount)).toBeUndefined();
    }
    expect(amountCount(undefined)).toBeUndefined();
  });

  // The whole table read at once, so a new entry written with an amount nobody
  // can parse shows up here rather than as an item that quietly cannot run out.
  it("reads an amount off every standard entry that has one", () => {
    const unreadable = EQUIPMENT_KEYS.filter((k) => {
      const t: ItemTemplate = STANDARD_EQUIPMENT[k];
      return t.amount !== undefined && amountCount(t.amount) === undefined;
    });
    // Four of Knave's own amounts are not counts at all — "whole", "capacity
    // 20" — and that is the case the undefined return exists for. Listed so a
    // fifth is a visible diff.
    expect(unreadable.sort()).toEqual(["cod", "quiver"]);
  });
});
