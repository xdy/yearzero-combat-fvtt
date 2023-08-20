// eslint-disable-next-line max-len
/** @typedef {import('@league-of-foundry-developers/foundry-vtt-types/src/foundry/client/data/documents/combat').InitiativeOptions} InitiativeOptions */
/** @typedef {import('./combatant').default} YearZeroCombatant */

import { YZEC } from '@module/config';
import { MODULE_ID, SETTINGS_KEYS } from '@module/constants';
import * as Utils from '@utils/utils';
import { duplicateCombatant, getCombatantsSharingToken } from './duplicate-combatant';
import { removeSlowAndFastActions } from './slow-and-fast-actions';

export default class YearZeroCombat extends Combat {
  /* ------------------------------------------ */
  /*  Properties                                */
  /* ------------------------------------------ */

  get history() {
    return this.getFlag(MODULE_ID, 'history') || {};
  }

  async setHistory($history) {
    return this.setFlag(MODULE_ID, 'history', $history);
  }

  /* ------------------------------------------ */
  /*  Methods                                   */
  /* ------------------------------------------ */
  /**
   * @param {string|string[]}    ids      The IDs of all the combatants in the combat
   * @param {InitiativeOptions} [options] Additional initiative options
   * @override
   */
  async rollInitiative(ids, options = {}) {
    // Structures data.
    if (!Array.isArray(ids)) ids = [ids];
    const { messageOptions = {} } = options;
    const messages = [];
    const updates = [];
    const skipMessage = false;
    const initiativeDeck = Utils.getInitiativeDeck(true);
    // const chatRollMode = game.settings.get('core', 'rollMode');

    // Iterates over each combatant.
    for (const id of ids) {
      /** @type {YearZeroCombatant} */
      const combatant = this.combatants.get(id, { strict: true });
      const inGroup = !!combatant.groupId;
      const isRedraw = !!combatant.initiative;

      if (combatant.isDefeated || inGroup || combatant.lockInitiative) continue;

      // Checks if enough cards are available.
      const cardsToDraw = combatant.getNumberOfCardsToDraw();
      if (cardsToDraw > initiativeDeck.availableCards.length) {
        ui.notifications.info('YZEC.Combat.Initiative.NotEnoughCards', { localize: true });
        await Utils.resetInitiativeDeck();
      }

      // Draws the cards.
      /** @type {Card} */
      let card;
      const cards = await this.drawCards(cardsToDraw);

      // FIXME DEBUG
      if (cards.length !== cardsToDraw) console.warn('Something went wrong: Incorrect number of cards drawn');

      if (isRedraw) {
        const previousCard = this.findCard(combatant.cardValue);
        if (previousCard) cards.push(previousCard);
      }

      if (cards.length > 1) {
        cards.sort((a, b) => (a.value - b.value) * Utils.getCardSortOrderModifier(combatant.keepState));

        if (game.settings.get(MODULE_ID, SETTINGS_KEYS.INITIATIVE_AUTODRAW)) {
          card = cards[0];
        }
        else {
          card = await this.chooseCard(cards, combatant);
        }
      }
      else {
        card = cards[0];
      }

      // Updates the combatant.
      const updateData = {
        initiative: card.value,
        [`flags.${MODULE_ID}.cardValue`]: card.value,
        [`flags.${MODULE_ID}.cardName`]: card.description || card.name,
      };
      updates.push({ _id: combatant.id, ...updateData });

      // Updates other combatants in the group.
      if (combatant.isGroupLeader) {
        updateData[`flags.${MODULE_ID}.cardValue`] += Utils.getCombatantSortOrderModifier();
        for (const follower of combatant.getFollowers()) {
          updates.push({ _id: follower.id, ...updateData });
        }
      }

      // Prepares the messages.
      const template = `modules/${MODULE_ID}/templates/chat/draw-initiative-chatcard.hbs`;
      const content = await renderTemplate(template, { card });

      const speakerData = {
        scene: game.scenes?.active?.id,
        actor: combatant.actor?.id,
        token: combatant.token?.id,
        alias: game.i18n.format('YZEC.Combat.Initiative.Draw', {
          name: combatant.token?.name ?? '???',
        }),
      };

      const messageData = foundry.utils.mergeObject(
        {
          content,
          speaker: speakerData,
          flavor: game.i18n.format('COMBAT.RollsInitiative', { name: combatant.name }),
          flags: { 'core.initiativeRoll': true },
          whisper: combatant.token?.hidden || combatant.hidden ? game.users.filter(u => u.isGM) : [],
        },
        messageOptions,
      );

      // If the combatant is hidden, use a private roll unless an alternative rollMode was explicitly requested
      // eslint-disable-next-line no-nested-ternary
      // messageData.rollMode = 'rollMode' in messageOptions
      //   ? messageOptions.rollMode
      //   : (combatant.hidden ? CONST.DICE_ROLL_MODES.PRIVATE : chatRollMode);

      messages.push(messageData);
    }

    // Updates the combatants.
    await this.updateEmbeddedDocuments('Combatant', updates);

    // Updates the combat instance with the new combatants.
    const currentId = this.combatant?.id;
    if (options.updateTurn) {
      await this.update({ turn: this.turns.findIndex(t => t.id === currentId) });
    }
    else if (options.newRound) {
      await this.update({ turn: 0 }, { diff: false });
    }

    // Creates multiple chat messages.
    if (!skipMessage) {
      this.playInitiativeSound(); // No need to await
    }
    if (!skipMessage && game.settings.get(MODULE_ID, SETTINGS_KEYS.INITIATIVE_MESSAGING)) {
      await CONFIG.ChatMessage.documentClass.createDocuments(messages);
    }

    return this;
  }

  /* ------------------------------------------ */

  /**
   * Draws cards from the Initiative deck.
   * @param {number} [qty=1] Quantity of cards to draw
   * @returns {Promise.<Card[]>}
   */
  async drawCards(qty = 1) {
    const initiativeDeck = Utils.getInitiativeDeck(true);
    const discardPile = Utils.getInitiativeDeckDiscardPile(true);
    return initiativeDeck.drawInitiative(discardPile, qty);
  }

  /* ------------------------------------------ */

  /**
   * Picks an initiative card for a combatant.
   * @param {Cards[]}           cards          (Already sorted)
   * @param {YearZeroCombatant} combatant
   * @param {number}           [bestCardValue] Value of the best card
   * @returns {Promise.<Card>}
   */
  async chooseCard(cards, combatant, bestCardValue) {
    const bestCard = cards.find(c => c.value === bestCardValue) ?? cards[0];
    const template = `modules/${MODULE_ID}/templates/combat/choose-card-dialog.hbs`;
    const content = await renderTemplate(template, {
      cards,
      bestCard,
      config: YZEC,
    });
    const buttons = {
      ok: {
        icon: '<i class="fas fa-check"></i>',
        label: game.i18n.localize('YZEC.OK'),
        callback: html => {
          const choice = html.find('input[name=card]:checked');
          const cardId = choice.data('card-id');
          return cards.find(c => c.id === cardId) ?? bestCard;
        },
      },
    };

    /**
     * @see {@link https://foundryvtt.com/api/classes/client.Dialog.html#wait}
     */
    return Dialog.wait(
      {
        title: `${combatant.name}: ${game.i18n.localize('YZEC.Combat.Initiative.ChooseCard')}`,
        content,
        buttons,
        default: 'ok',
        // Default value returned
        close: () => bestCard,
      },
      {
        classes: ['dialog', MODULE_ID, game.system.id],
      },
      {},
    );
  }

  /* ------------------------------------------ */

  /**
   * Finds a specific card in the deck.
   * @param {number} cardValue
   * @returns {Card|undefined}
   */
  findCard(cardValue) {
    const initiativeDeck = Utils.getInitiativeDeck(true);
    return initiativeDeck.cards.find(c => c.value === cardValue);
  }

  /* ------------------------------------------ */
  /*  Overridden Core Methods                   */
  /* ------------------------------------------ */

  /**
   * Sorts the combatants by initiative ascending order (low to high).
   * @param {YearZeroCombatant} a
   * @param {YearZeroCombatant} b
   * @override
   */
  _sortCombatants(a, b) {
    if (!a || !b) return 0;
    // Sorts by card value:
    if (a.flags[MODULE_ID] && b.flags[MODULE_ID]) {
      const n = Utils.getCardSortOrderModifier();
      if (a.cardValue < b.cardValue) return -n;
      if (a.cardValue > b.cardValue) return +n;
      return 0;
    }
    // Sorts by name otherwise:
    else {
      const cn = a.name.localeCompare(b.name);
      if (cn !== 0) return cn;
      return a.id.localeCompare(b.id);
    }
  }

  /* ------------------------------------------ */

  /** @override */
  async resetAll() {
    for (const combatant of this.combatants) {
      if (combatant.lockInitiative && !combatant.isDefeated) continue;
      await combatant.resetInitiative();
    }
    return this.update({ turn: 0, combatants: this.combatants.toObject() }, { diff: false });
  }

  /* ------------------------------------------ */

  /** @override */
  async startCombat() {
    // Duplicates combatants with speed > 1.
    if (game.settings.get(MODULE_ID, SETTINGS_KEYS.DUPLICATE_COMBATANTS_ON_START)) {
      for (const combatant of this.combatants) {
        const speed = combatant.getSpeedFromActor();
        if (speed > 1) {
          const duplicatas = getCombatantsSharingToken(combatant);
          const copyQty = speed - duplicatas.length;
          if (copyQty > 0) await duplicateCombatant(combatant, copyQty);
        }
      }
    }

    // Draws initiative for each combatant.
    if (game.settings.get(MODULE_ID, SETTINGS_KEYS.INITIATIVE_RESET_DECK_ON_START)) {
      await Utils.resetInitiativeDeck();
    }

    if (game.settings.get(MODULE_ID, SETTINGS_KEYS.INITIATIVE_AUTODRAW)) {
      const ids = this.combatants.filter(c => !c.isDefeated && c.initiative == null).map(c => c.id);
      await this.rollInitiative(ids);
    }

    return super.startCombat();
  }

  /* ------------------------------------------ */

  /** @override */
  async endCombat() {
    const toEnd = await super.endCombat();
    if (toEnd && game.settings.get(MODULE_ID, SETTINGS_KEYS.SLOW_AND_FAST_ACTIONS)) {
      for (const combatant of this.combatants) {
        await removeSlowAndFastActions(combatant.token);
      }
    }
  }

  /* ------------------------------------------ */

  /** @override */
  async nextRound() {

    // Save the state of the combatants before we end the previous round.
    await this.setHistory({ ...this.history, [this.round]: this.combatants.map(c => c.toObject()) });

    const updates = [];
    for (const combatant of this.combatants) {
      try {
        await removeSlowAndFastActions(combatant.token);
      }
      catch (err) {
        ui.notifications.error(err);
      }
      updates.push({
        _id: combatant.id,
        [`flags.${MODULE_ID}.-=fastAction`]: null,
        [`flags.${MODULE_ID}.-=slowAction`]: null,
      });
    }
    await this.updateEmbeddedDocuments('Combatant', updates);

    await super.nextRound();

    // Check if state exists for this round and restore it.
    const roundState = this.history[this.round];

    // Resets the initiative of all combatants at the start of the round.
    if (game.settings.get(MODULE_ID, SETTINGS_KEYS.RESET_EACH_ROUND) && !roundState) {
      this.#resetInitiativeAtEndOfRound();
    }
    else if (roundState) await this.update({ ['combatants']: roundState }, { diff: false });

    return this;
  }

  /* ------------------------------------------ */

  /** @override */
  async previousRound() {
    // Save the state of the combatants before we end the current round.
    await this.setHistory({ ...this.history, [this.round]: this.combatants.map(c => c.toObject()) });

    // Proceed to previous round.
    await super.previousRound();

    const roundState = this.history[this.round];

    if (roundState) {
      await this.update({ ['combatants']: roundState }, { diff: false });
    }

    return this;
  }

  /* ------------------------------------------ */
  /*  Utility Methods                           */
  /* ------------------------------------------ */

  /**
   * Plays a *drawing card* sound.
   * @private
   */
  async playInitiativeSound() {
    const data = {
      src: `modules/${MODULE_ID}/assets/sounds/card-flip.wav`,
      volume: 0.75,
      autoplay: true,
      loop: false,
    };
    return AudioHelper.play(data);
  }

  /**
   * Resets the initiative of all combatants at the start of the round. Optionally resets the initiative deck,
   * and draws cards for combatants with no initiative.
   * @private
   * @returns {Promise.<void>}
   */
  async #resetInitiativeAtEndOfRound() {
    await this.resetAll();

    if (game.settings.get(MODULE_ID, SETTINGS_KEYS.INITIATIVE_RESET_DECK_ON_START)) {
      const lockedCards = this.combatants.filter(c => c.lockInitiative).map(c => c.cardValue);
      await Utils.resetInitiativeDeck(true, lockedCards);
    }

    if (game.settings.get(MODULE_ID, SETTINGS_KEYS.INITIATIVE_AUTODRAW)) {
      const ids = this.combatants.map(c => c.id);
      await this.rollInitiative(ids, { newRound: true });
    }
  }
}
