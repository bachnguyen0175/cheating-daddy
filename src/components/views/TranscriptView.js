import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class TranscriptView extends LitElement {
    static styles = css`
        :host {
            height: 100%;
            display: flex;
            flex-direction: column;
        }

        * {
            font-family: var(--font);
            cursor: default;
        }

        .transcript-container {
            flex: 1;
            overflow-y: auto;
            background: var(--bg-app);
            padding: var(--space-sm) var(--space-md);
            scroll-behavior: smooth;
        }

        /* Japanese needs a CJK-capable stack and looser leading than the Latin UI font. */
        .ja {
            font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', 'MS Gothic', var(--font), sans-serif;
            font-size: var(--response-font-size, 16px);
            line-height: 1.75;
            color: var(--text-primary);
            word-break: break-word;
        }

        .translation {
            font-size: calc(var(--response-font-size, 16px) - 2px);
            line-height: 1.6;
            color: var(--text-secondary);
            margin-top: 2px;
            word-break: break-word;
        }

        .translation.pending {
            opacity: 0.45;
            font-style: italic;
        }

        .line {
            padding: 6px 0;
            border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.06));
        }

        .time {
            font-size: 10px;
            color: var(--text-secondary);
            opacity: 0.6;
            margin-bottom: 2px;
            font-variant-numeric: tabular-nums;
        }

        /* The in-flight utterance, visually distinct from committed lines. */
        .live {
            padding: 6px 0;
            opacity: 0.75;
        }

        .live .ja::after {
            content: '▌';
            opacity: 0.6;
            margin-left: 1px;
        }

        .empty {
            color: var(--text-secondary);
            font-size: 13px;
            text-align: center;
            padding: var(--space-lg, 24px) var(--space-md);
            line-height: 1.6;
        }

        .jump-btn {
            position: sticky;
            bottom: 6px;
            display: block;
            margin: 0 auto;
            padding: 4px 10px;
            font-size: 11px;
            border: none;
            border-radius: 10px;
            background: var(--bg-elevated, rgba(255, 255, 255, 0.12));
            color: var(--text-primary);
            cursor: pointer;
        }
    `;

    static properties = {
        lines: { type: Array },
        partial: { type: String },
        translateTo: { type: String },
        _pinned: { state: true },
    };

    constructor() {
        super();
        this.lines = [];
        this.partial = '';
        this.translateTo = '';
        this._pinned = true;
    }

    updated(changed) {
        if ((changed.has('lines') || changed.has('partial')) && this._pinned) {
            this._scrollToBottom();
        }
    }

    _scrollToBottom() {
        const container = this.shadowRoot.querySelector('.transcript-container');
        if (container) container.scrollTop = container.scrollHeight;
    }

    // Suspend auto-scroll once the user scrolls up, so reading back isn't yanked.
    _handleScroll(e) {
        const el = e.target;
        this._pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }

    _jumpToLive() {
        this._pinned = true;
        this._scrollToBottom();
    }

    _formatTime(timestamp) {
        const d = new Date(timestamp);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    }

    render() {
        const isEmpty = this.lines.length === 0 && !this.partial;

        return html`
            <div class="transcript-container" @scroll=${this._handleScroll}>
                ${isEmpty ? html`<div class="empty">Waiting for audio…<br />Make sure the meeting audio is being shared.</div>` : ''}
                ${this.lines.map(
                    line => html`
                        <div class="line">
                            <div class="time">${this._formatTime(line.timestamp)}</div>
                            <div class="ja">${line.text}</div>
                            ${
                                this.translateTo
                                    ? line.translation
                                        ? html`<div class="translation">${line.translation}</div>`
                                        : html`<div class="translation pending">
                                              ${line.translationError ? 'translation unavailable' : 'translating…'}
                                          </div>`
                                    : ''
                            }
                        </div>
                    `
                )}
                ${this.partial ? html`<div class="live"><div class="ja">${this.partial}</div></div>` : ''}
                ${!this._pinned ? html`<button class="jump-btn" @click=${this._jumpToLive}>Jump to live</button>` : ''}
            </div>
        `;
    }
}

customElements.define('transcript-view', TranscriptView);
