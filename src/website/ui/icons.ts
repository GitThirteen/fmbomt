import add from '../../assets/img/add.svg?raw';
import deleteIcon from '../../assets/img/delete.svg?raw';
import download from '../../assets/img/download.svg?raw';
import play from '../../assets/img/play.svg?raw';
import refit from '../../assets/img/refit.svg?raw';
import reset from '../../assets/img/reset.svg?raw';
import select from '../../assets/img/select.svg?raw';
import tools from '../../assets/img/tools.svg?raw';

const ICONS = {
    play,
    tools,
    select,
    add,
    delete: deleteIcon,
    reset,
    refit,
    download,
} as const;

export type IconName = keyof typeof ICONS;

/** Replace the contents of every `[data-icon]` host with its icon. */
export function initIcons(): void {
    document.querySelectorAll<HTMLElement>('[data-icon]').forEach((host) => {
        const name = host.dataset.icon as IconName | undefined;
        if (!name || !(name in ICONS)) return;
        const size = host.dataset.iconSize ?? '20';
        host.innerHTML = ICONS[name];
        const svg = host.querySelector('svg');
        svg?.setAttribute('width', size);
        svg?.setAttribute('height', size);
        host.setAttribute('aria-hidden', 'true');
    });
}
