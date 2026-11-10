// Stripe.js as the fake Stripe stands it in, for Checkout Sessions in `elements` mode: the
// pieces a page composes (the Payment and Express Checkout Elements) and the actions it calls.
// It is served for https://js.stripe.com and asks https://api.stripe.com, which a page route
// sends to the fake, so the page's own Content-Security-Policy is the one production has.

/** The release train `@stripe/stripe-js` expects Stripe.js to report. */
export const RELEASE_TRAIN = 'endive';

/** The card the stand-in's Payment Element refuses, as Stripe's test card of that number does. */
export const DECLINED_CARD = '4000000000000002';

/** A script the fake serves, as Stripe serves Stripe.js. */
export class Script {
  public readonly source: string;

  public constructor(source: string) {
    this.source = source;
  }
}

/** The stand-in, as a script: no module, as Stripe.js is none. */
export const STRIPE_JS = String.raw`(() => {
  const API = 'https://api.stripe.com/fake/elements/';
  const sessionOf = (secret) => secret.split('_secret_')[0];
  const ask = async (session, action, fields) => {
    const target = API + encodeURIComponent(session) + (action === undefined ? '' : '/' + action);
    const init =
      action === undefined
        ? {}
        : { method: 'POST', body: new URLSearchParams(Object.entries(fields ?? {})) };
    const response = await fetch(target, init);
    return response.json();
  };
  const later = (run) => {
    setTimeout(run, 0);
  };
  const element = (render) => {
    const handlers = new Map();
    let node;
    const emit = (name, event) => {
      for (const handler of handlers.get(name) ?? []) {
        handler(event);
      }
    };
    return {
      mount(target) {
        const host = typeof target === 'string' ? document.querySelector(target) : target;
        node = render(emit);
        host.replaceChildren(node);
        later(() => {
          emit('ready', { elementType: 'stand-in', availablePaymentMethods: { link: true } });
        });
      },
      on(name, handler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        return this;
      },
      off(name) {
        handlers.delete(name);
        return this;
      },
      update() {},
      focus() {},
      blur() {},
      clear() {},
      unmount() {
        node?.remove();
      },
      destroy() {
        node?.remove();
        handlers.clear();
      },
    };
  };
  const initCheckoutElementsSdk = ({ clientSecret }) => {
    const listeners = [];
    const state = { session: undefined, card: '' };
    const id = Promise.resolve(clientSecret).then(sessionOf);
    const complete = () => state.card.replaceAll(' ', '').length >= 12;
    const publish = () => {
      for (const listener of listeners) {
        listener(state.session);
      }
    };
    const take = (body) => {
      state.session = Object.assign(body, { canConfirm: complete() });
      publish();
    };
    const read = async () => {
      take(await ask(await id));
      return state.session;
    };
    const loaded = read();
    const answer = (reply) => {
      if (reply.type !== 'success') {
        return { type: 'error', error: reply.error };
      }
      take(reply.session);
      return { type: 'success', session: state.session };
    };
    const actions = {
      getSession: () => state.session,
      updateEmail: async (email) => answer(await ask(await id, 'email', { email: email ?? '' })),
      applyPromotionCode: async (code) => answer(await ask(await id, 'promotion', { code })),
      removePromotionCode: async () => answer(await ask(await id, 'promotion', { code: '' })),
      confirm: async (options = {}) => {
        const fields = options.expressCheckoutConfirmEvent === undefined ? { card: state.card } : { wallet: 'link' };
        if (options.email !== undefined) {
          fields.email = options.email;
        }
        const reply = await ask(await id, 'confirm', fields);
        const result = await answer(reply);
        if (result.type === 'success' && options.redirect !== 'if_required') {
          location.assign(reply.return_url);
        }
        return result;
      },
    };
    const elements = { payment: null, express: null };
    return {
      on(name, handler) {
        if (name === 'change') {
          listeners.push(handler);
          if (state.session !== undefined) {
            handler(state.session);
          }
        }
      },
      loadActions: async () => {
        await loaded;
        return { type: 'success', actions };
      },
      changeAppearance() {},
      createPaymentElement() {
        elements.payment = element((emit) => {
          const label = document.createElement('label');
          const input = document.createElement('input');
          label.append('Card number', input);
          input.inputMode = 'numeric';
          input.autocomplete = 'cc-number';
          input.addEventListener('input', () => {
            state.card = input.value;
            if (state.session !== undefined) {
              take(state.session);
            }
            emit('change', { complete: complete(), empty: state.card === '' });
          });
          return label;
        });
        return elements.payment;
      },
      createExpressCheckoutElement() {
        elements.express = element((emit) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = 'Pay with Link';
          button.addEventListener('click', () => {
            emit('confirm', { expressPaymentType: 'link', paymentFailed() {} });
          });
          return button;
        });
        return elements.express;
      },
      getPaymentElement: () => elements.payment,
      getExpressCheckoutElement: () => elements.express,
    };
  };
  const Stripe = () => ({ initCheckoutElementsSdk, _registerWrapper() {}, registerAppInfo() {} });
  window.Stripe = Object.assign(Stripe, { version: '${RELEASE_TRAIN}' });
})();
`;
