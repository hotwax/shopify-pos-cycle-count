export class CountQuantityEdits {
  constructor(write) {
    this.write = write;
    this.drafts = new Map();
    this.writes = new Map();
  }

  setDraft(item, text) {
    const quantity = Number(text);
    if (text === '' || quantity === item.quantity) this.drafts.delete(item.productId);
    else if (!Object.is(quantity, this.drafts.get(item.productId)?.quantity))
      this.drafts.set(item.productId, {item, quantity});
  }

  async commit(item, change) {
    const id = item.productId;
    if (this.writes.has(id)) return this.writes.get(id);
    const {quantity} = change;
    if (quantity !== undefined && (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000))
      throw new Error('Use a whole number from 0 to 1,000,000.');

    const draft = this.drafts.get(id);
    const task = Promise.resolve().then(() => this.write(item, change)).then(saved => {
      if (saved == null) throw new Error('Could not save this quantity. Try again.');
      if (draft === this.drafts.get(id)) this.drafts.delete(id);
      return saved;
    }).finally(() => this.writes.delete(id));
    this.writes.set(id, task);
    return task;
  }

  async flush() {
    await Promise.all(this.writes.values());
    for (const {item, quantity} of this.drafts.values()) await this.commit(item, {quantity});
  }
}
