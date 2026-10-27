(function (root) {
  'use strict';

  const HINTS = Object.freeze(['model', 'architecture', 'bitness', 'platformVersion', 'fullVersionList']);
  const text = (value) => typeof value === 'string' && value.length <= 4096;
  const numeric = (value) => typeof value === 'number' && Number.isFinite(value);
  const boolean = (value) => typeof value === 'boolean';
  const languages = (value) => Array.isArray(value) && value.length <= 64 && value.every(text);
  const brands = (value) => Array.isArray(value) && value.length <= 32 && value.every((entry) =>
    entry && text(entry.brand) && text(entry.version) && Object.keys(entry).length === 2);
  const entropyShape = {
    model: text, architecture: text, bitness: text, platformVersion: text, fullVersionList: brands
  };
  const screenShape = {
    width: numeric, height: numeric, availWidth: numeric, availHeight: numeric,
    colorDepth: numeric, pixelDepth: numeric, orientation: { type: text, angle: numeric }
  };
  const baseShape = {
    date: {
      epochMilliseconds: numeric, localString: text, timezoneOffset: numeric,
      januaryTimezoneOffset: numeric, julyTimezoneOffset: numeric
    },
    intl: { timeZone: text, locale: text },
    navigator: {
      language: text, languages, userAgent: text, platform: text,
      hardwareConcurrency: numeric, deviceMemory: numeric, maxTouchPoints: numeric,
      userAgentData: {
        brands, mobile: boolean, platform: text,
        highEntropy: {
          status: (value) => ['ok', 'unsupported', 'failed'].includes(value),
          values: entropyShape,
          code: (value) => ['API_UNSUPPORTED', 'UA_DATA_FAILED', 'UA_DATA_TIMEOUT', 'CLOCK_FAILED'].includes(value)
        }
      }
    }
  };

  // A bounded schema also rejects extra fields coming back over a message boundary.
  function matches(value, shape, nullable = true) {
    if (value === null) return nullable;
    if (typeof shape === 'function') return shape(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(shape);
    const optionalCode = Object.prototype.hasOwnProperty.call(shape, 'code');
    if (Object.keys(value).some((key) => !keys.includes(key))) return false;
    return keys.every((key) => key === 'code' && optionalCode && value[key] === undefined
      ? true : Object.prototype.hasOwnProperty.call(value, key) && matches(value[key], shape[key]));
  }

  function validValues(value, windowRealm) {
    const shape = windowRealm ? { ...baseShape, screen: screenShape, devicePixelRatio: numeric } : baseShape;
    if (!matches(value, shape, false) || !value.date || !value.intl || !value.navigator) return false;
    const data = value.navigator.userAgentData;
    if (!data) return data === null;
    const high = data.highEntropy;
    if (!high || !high.values || high.status === null) return false;
    if (high.status === 'ok') return high.code === undefined;
    if (high.status === 'unsupported') return high.code === 'API_UNSUPPORTED';
    return ['UA_DATA_FAILED', 'UA_DATA_TIMEOUT', 'CLOCK_FAILED'].includes(high.code);
  }

  function emptyEntropy() {
    return { model: null, architecture: null, bitness: null, platformVersion: null, fullVersionList: null };
  }

  async function collect(realm, windowRealm) {
    let fault = null;
    let faults = 0;
    function read(getter, validator) {
      try {
        const value = getter();
        if (value === undefined || value === null) return null;
        if (validator && !validator(value)) throw new TypeError();
        return value;
      } catch (error) {
        fault = fault || 'READ_FAILED';
        faults += 1;
        return null;
      }
    }
    function property(object, key, validator) {
      return read(() => object == null ? undefined : object[key], validator);
    }
    function brandList(object, key) {
      return read(() => {
        const list = object == null ? undefined : object[key];
        if (list == null) return list;
        if (!Array.isArray(list) || list.length > 32) throw new TypeError();
        return list.map((entry) => ({ brand: entry.brand, version: entry.version }));
      }, brands);
    }
    const DateConstructor = property(realm, 'Date');
    const now = read(() => typeof DateConstructor === 'function' ? new DateConstructor() : undefined);
    // Fixed UTC sampling instants, not expected timezone values.
    const january = read(() => typeof DateConstructor === 'function'
      ? new DateConstructor('2026-01-15T00:00:00.000Z') : undefined);
    const july = read(() => typeof DateConstructor === 'function'
      ? new DateConstructor('2026-07-15T00:00:00.000Z') : undefined);
    function dateNumber(date, name) {
      return read(() => date && typeof date[name] === 'function' ? date[name]() : undefined, numeric);
    }
    const intl = property(realm, 'Intl');
    const options = read(() => intl && typeof intl.DateTimeFormat === 'function'
      ? new intl.DateTimeFormat().resolvedOptions() : undefined);
    const navigator = property(realm, 'navigator');
    const values = {
      date: {
        epochMilliseconds: dateNumber(now, 'getTime'),
        localString: read(() => now && typeof now.toString === 'function' ? now.toString() : undefined, text),
        timezoneOffset: dateNumber(now, 'getTimezoneOffset'),
        januaryTimezoneOffset: dateNumber(january, 'getTimezoneOffset'),
        julyTimezoneOffset: dateNumber(july, 'getTimezoneOffset')
      },
      intl: { timeZone: property(options, 'timeZone', text), locale: property(options, 'locale', text) },
      navigator: {
        language: property(navigator, 'language', text),
        languages: read(() => {
          const list = navigator == null ? undefined : navigator.languages;
          return list == null ? list : Array.isArray(list) ? Array.from(list) : list;
        }, languages),
        userAgent: property(navigator, 'userAgent', text),
        platform: property(navigator, 'platform', text),
        hardwareConcurrency: property(navigator, 'hardwareConcurrency', numeric),
        deviceMemory: property(navigator, 'deviceMemory', numeric),
        maxTouchPoints: property(navigator, 'maxTouchPoints', numeric),
        userAgentData: null
      }
    };
    if (windowRealm) {
      const screen = property(realm, 'screen');
      const orientation = property(screen, 'orientation');
      values.screen = screen == null ? null : {
        width: property(screen, 'width', numeric), height: property(screen, 'height', numeric),
        availWidth: property(screen, 'availWidth', numeric), availHeight: property(screen, 'availHeight', numeric),
        colorDepth: property(screen, 'colorDepth', numeric), pixelDepth: property(screen, 'pixelDepth', numeric),
        orientation: orientation == null ? null : {
          type: property(orientation, 'type', text), angle: property(orientation, 'angle', numeric)
        }
      };
      values.devicePixelRatio = property(realm, 'devicePixelRatio', numeric);
    }
    const data = property(navigator, 'userAgentData');
    if (data != null) {
      const high = { status: 'unsupported', values: emptyEntropy(), code: 'API_UNSUPPORTED' };
      values.navigator.userAgentData = {
        brands: brandList(data, 'brands'), mobile: property(data, 'mobile', boolean),
        platform: property(data, 'platform', text), highEntropy: high
      };
      const beforeGetter = faults;
      const getHigh = property(data, 'getHighEntropyValues');
      if (faults !== beforeGetter) {
        high.status = 'failed';
        high.code = 'UA_DATA_FAILED';
      }
      if (getHigh != null) {
        const outcome = await root.AbsIdentityTiming.within(realm, 1200,
          () => getHigh.call(data, Array.from(HINTS)), { timeout: 'UA_DATA_TIMEOUT', error: 'UA_DATA_FAILED' });
        if (outcome.ok && outcome.value && typeof outcome.value === 'object' && !Array.isArray(outcome.value)) {
          const before = faults;
          high.values = {
            model: property(outcome.value, 'model', text), architecture: property(outcome.value, 'architecture', text),
            bitness: property(outcome.value, 'bitness', text),
            platformVersion: property(outcome.value, 'platformVersion', text),
            fullVersionList: brandList(outcome.value, 'fullVersionList')
          };
          high.status = faults !== before ? 'failed' : 'ok';
          if (high.status === 'ok') delete high.code;
          else high.code = 'UA_DATA_FAILED';
        } else {
          high.status = 'failed';
          high.code = outcome.ok ? 'UA_DATA_FAILED' : outcome.code;
        }
        if (high.status === 'failed') fault = fault || high.code;
      }
    }
    return fault ? { status: 'failed', values, code: fault } : { status: 'ok', values };
  }

  root.AbsIdentityReadings = Object.freeze({ collect, validValues });
})(globalThis);
