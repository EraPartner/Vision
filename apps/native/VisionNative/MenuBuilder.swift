import AppKit
import VisionNativeCore

/// Carries a `MenuCommand` on an `NSMenuItem`.
final class MenuCommandBox: NSObject {
    let command: MenuCommand

    init(_ command: MenuCommand) {
        self.command = command
        super.init()
    }
}

/// Turns the `ApplicationMenu` model into AppKit menus. Electron's role items map to the
/// standard AppKit actions, sent through the responder chain; everything else calls the
/// shell controller.
@MainActor
final class MenuController: NSObject, NSMenuItemValidation {
    weak var shell: ShellController?

    @objc func performMenuCommand(_ sender: NSMenuItem) {
        guard let box = sender.representedObject as? MenuCommandBox else { return }
        shell?.run(box.command)
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let box = menuItem.representedObject as? MenuCommandBox, box.command == .print else { return true }
        return shell?.canPrintCurrentPage == true
    }

    func makeMenu(title: String, entries: [MenuEntry]) -> NSMenu {
        let menu = NSMenu(title: title)
        for entry in entries {
            switch entry {
            case .separator:
                menu.addItem(.separator())
            case .item(let model):
                let item = NSMenuItem(title: model.title, action: nil, keyEquivalent: model.keyEquivalent?.key ?? "")
                if let key = model.keyEquivalent { item.keyEquivalentModifierMask = Self.flags(key.modifiers) }
                if model.isHidden {
                    item.isHidden = true
                    item.allowsKeyEquivalentWhenHidden = true
                }
                configure(item, model.command)
                menu.addItem(item)
            case .submenu(let submenuTitle, let role, let children):
                let item = NSMenuItem(title: submenuTitle, action: nil, keyEquivalent: "")
                let submenu = makeMenu(title: submenuTitle, entries: children)
                item.submenu = submenu
                menu.addItem(item)
                switch role {
                case .services: NSApp.servicesMenu = submenu
                case .window: NSApp.windowsMenu = submenu
                case .help: NSApp.helpMenu = submenu
                case .plain: break
                }
            }
        }
        return menu
    }

    static func flags(_ modifiers: KeyModifiers) -> NSEvent.ModifierFlags {
        var flags: NSEvent.ModifierFlags = []
        if modifiers.contains(.command) { flags.insert(.command) }
        if modifiers.contains(.shift) { flags.insert(.shift) }
        if modifiers.contains(.option) { flags.insert(.option) }
        if modifiers.contains(.control) { flags.insert(.control) }
        return flags
    }

    private func configure(_ item: NSMenuItem, _ command: MenuCommand) {
        switch command {
        case .hide:
            item.action = #selector(NSApplication.hide(_:))
        case .hideOthers:
            item.action = #selector(NSApplication.hideOtherApplications(_:))
        case .showAll:
            item.action = #selector(NSApplication.unhideAllApplications(_:))
        case .quit:
            item.action = #selector(NSApplication.terminate(_:))
        case .bringAllToFront:
            item.action = #selector(NSApplication.arrangeInFront(_:))
        case .closeWindow:
            item.action = #selector(NSWindow.performClose(_:))
        case .minimize:
            item.action = #selector(NSWindow.performMiniaturize(_:))
        case .zoom:
            item.action = #selector(NSWindow.performZoom(_:))
        case .toggleFullScreen:
            item.action = #selector(NSWindow.toggleFullScreen(_:))
        case .undo:
            item.action = Selector(("undo:"))
        case .redo:
            item.action = Selector(("redo:"))
        case .cut:
            item.action = #selector(NSText.cut(_:))
        case .copy:
            item.action = #selector(NSText.copy(_:))
        case .paste:
            item.action = #selector(NSText.paste(_:))
        case .selectAll:
            item.action = #selector(NSText.selectAll(_:))
        case .services:
            break
        case .renderer, .openExternal, .about, .reload, .resetZoom, .zoomIn, .zoomOut, .print:
            item.target = self
            item.action = #selector(performMenuCommand(_:))
            item.representedObject = MenuCommandBox(command)
        }
    }
}
