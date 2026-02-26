import { CosmeticConfig, SiteSettings } from '@mugenblock/shared';

const STYLE_ELEMENT_ID = 'mugen-shield-v3';

export class CosmeticEngine {
    private cssHash = '';

    public applyCss(config: CosmeticConfig): void {
        const allSelectors = [...config.fastSelectors, ...config.slowSelectors];
        if (!allSelectors.length) return;

        const newHash = this.simpleHash(allSelectors.join(','));
        if (this.cssHash === newHash && document.getElementById(STYLE_ELEMENT_ID)) return;
        this.cssHash = newHash;

        let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement;
        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ELEMENT_ID;
            (document.head || document.documentElement).appendChild(style);
        }

        const selectorBlock = allSelectors.join(',\n');
        style.textContent = `${selectorBlock} {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
            height: 0 !important;
            width: 0 !important;
            overflow: hidden !important;
        }`;
    }

    public removeCss(): void {
        const style = document.getElementById(STYLE_ELEMENT_ID);
        if (style) style.remove();
        this.cssHash = '';
    }

    private simpleHash(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
        }
        return hash.toString(36);
    }
}
