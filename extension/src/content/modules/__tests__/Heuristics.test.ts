import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeuristicsEngine } from '../Heuristics';

// Mock IntersectionObserver
vi.stubGlobal(
    'IntersectionObserver',
    class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
    },
);

// Manual Mock for DOM elements
class MockElement {
    tagName: string;
    attributes: Record<string, string> = {};
    style: any = {};
    innerText = '';
    children = [];
    childNodes = [];

    constructor(tagName: string) {
        this.tagName = tagName.toUpperCase();
    }

    setAttribute(name: string, value: string) {
        this.attributes[name] = value;
    }
    getAttribute(name: string) {
        return this.attributes[name] || null;
    }
    hasAttribute(name: string) {
        return name in this.attributes;
    }
    getAttributeNames() {
        return Object.keys(this.attributes);
    }
    getBoundingClientRect() {
        return { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
    }
    querySelector() {
        return null;
    }
    closest() {
        return null;
    }

    get className() {
        return this.attributes['class'] || '';
    }
    set className(v) {
        this.attributes['class'] = v;
    }

    get id() {
        return this.attributes['id'] || '';
    }
    set id(v) {
        this.attributes['id'] = v;
    }
}

class MockIFrameElement extends MockElement {
    src = '';
    constructor() {
        super('iframe');
    }
}

// Stub globals
vi.stubGlobal('HTMLElement', MockElement);
vi.stubGlobal('Element', MockElement);
vi.stubGlobal('HTMLIFrameElement', MockIFrameElement);
vi.stubGlobal('window', {
    innerWidth: 1024,
    innerHeight: 768,
    getComputedStyle: vi.fn().mockReturnValue({}),
    location: { hostname: 'example.com' },
});
vi.stubGlobal('location', { hostname: 'example.com' });
vi.stubGlobal('document', {
    createElement: (tag: string) => {
        if (tag === 'iframe') return new MockIFrameElement();
        return new MockElement(tag);
    },
});

describe('HeuristicsEngine', () => {
    let engine: HeuristicsEngine;

    beforeEach(() => {
        engine = new HeuristicsEngine();
        vi.clearAllMocks();
    });

    it('should never flag whitelisted semantic elements', () => {
        const header = new MockElement('header') as any;
        expect(engine.analyzeNode(header, 'standard').isAd).toBe(false);

        const nav = new MockElement('nav') as any;
        expect(engine.analyzeNode(nav, 'standard').isAd).toBe(false);
    });

    it('should flag ad-sized iframes with suspicious attributes', () => {
        const iframe = new MockIFrameElement() as any;
        iframe.getBoundingClientRect = vi.fn().mockReturnValue({
            width: 300,
            height: 250,
            top: 0,
            left: 0,
            bottom: 250,
            right: 300,
        });
        iframe.setAttribute('sandbox', 'allow-popups-to-escape-sandbox');

        const result = engine.analyzeNode(iframe, 'standard');
        expect(result.isAd).toBe(true);
        expect(result.reason).toBe('Malicious Ad Iframe Fingerprint');
    });

    it('should flag ghost overlays (large, transparent, high z-index)', () => {
        const div = new MockElement('div') as any;
        div.getBoundingClientRect = vi.fn().mockReturnValue({
            width: 800,
            height: 600,
            top: 0,
            left: 0,
            bottom: 600,
            right: 800,
        });

        vi.mocked(window.getComputedStyle).mockReturnValue({
            zIndex: '1001',
            opacity: '0.05',
            pointerEvents: 'auto',
            position: 'fixed',
        } as any);

        const result = engine.analyzeNode(div, 'standard');
        expect(result.isAd).toBe(true);
        expect(result.reason).toContain('Ghost Overlay');
    });

    it('should NOT flag framework-marked elements (Vue/Angular)', () => {
        const div = new MockElement('div') as any;
        div.setAttribute('data-v-12345', '');
        div.className = 'some-very-long-random-looking-class-name-1234567890';

        const result = engine.analyzeNode(div, 'advanced');
        expect(result.isAd).toBe(false);
    });

    it('should flag DGA domains but spare CDNs', () => {
        const engineAny = engine as any;

        // CDN should not be suspicious
        expect(engineAny.isSuspiciousDomain('https://ytimg.com/vi/123/default.jpg')).toBe(false);
        expect(engineAny.isSuspiciousDomain('https://gstatic.com/something')).toBe(false);

        // DGA-like domain should be suspicious
        expect(engineAny.isSuspiciousDomain('https://bcdfghjklmnpqr.com')).toBe(true);

        // Suspicious TLD and random/repetitive name
        expect(engineAny.isSuspiciousDomain('https://aaaaaaaaaaab.top')).toBe(true);
    });
});
