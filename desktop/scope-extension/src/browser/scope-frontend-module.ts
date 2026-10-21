// SPDX-License-Identifier: MIT
import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { FrontendApplicationContribution, KeybindingContribution, WidgetFactory } from '@theia/core/lib/browser';
import { bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { ColorContribution } from '@theia/core/lib/browser/color-application-contribution';
import { ScopeSession } from './scope-session';
import { ScopeVisionWidget, ScopeDeviceWidget } from './scope-widgets';
import { ScopeColorContribution, ScopeThemeContribution } from './scope-theme';
import { ScopeDeviceContribution, ScopeLayoutState, ScopeToolbar, ScopeVisionContribution, ScopeWorkbenchContribution } from './scope-workbench';
import { NoduVisionToolsContribution } from './nodu-vision-tools';
import { NoduFileToolsContribution } from './nodu-file-tools';
import { NoduMediaToolsContribution } from './nodu-media-tools';
import { NoduTerminalContribution } from './nodu-terminal-tools';
import { NoduFileDocsContribution } from './nodu-file-docs';
import { NoduEditorMenusContribution } from './nodu-editor-menus';
import { NoduDeviceModel } from './nodu-device-client';
import { NoduResources } from './nodu-resources-client';
import { NODU_UPDATE_SCHEMA, NoduUpdateContribution } from './nodu-update';
import { PreferenceContribution } from '@theia/core/lib/common/preferences/preference-schema';
import { NoduConsoleWidget } from './nodu-console-widget';
import { NoduBoardGuideContribution, NoduBoardWidget } from './nodu-board-widget';
import { ScopeConsoleContribution } from './scope-workbench';
import { NoduBoardFilesContribution, NoduBoardFilesWidget } from './nodu-board-files';
import '../../style/scope.css';
import '../../style/widgets.css';
import '../../style/layout.css';
import '../../style/device.css';
import '../../style/board-guide.css';

export default new ContainerModule(bind => {
    bind(NoduDeviceModel).toSelf().inSingletonScope();
    bind(ScopeSession).toSelf().inSingletonScope();
    bind(ScopeLayoutState).toSelf().inSingletonScope();
    bind(ScopeToolbar).toSelf().inSingletonScope();
    bind(ScopeVisionWidget).toSelf();
    bind(ScopeDeviceWidget).toSelf();
    bind(NoduConsoleWidget).toSelf();
    bind(NoduBoardWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({ id: NoduBoardWidget.ID, createWidget: () => ctx.container.get(NoduBoardWidget) })).inSingletonScope();
    bindViewContribution(bind, NoduBoardGuideContribution);
    bind(WidgetFactory).toDynamicValue(ctx => ({ id: ScopeVisionWidget.ID, createWidget: () => ctx.container.get(ScopeVisionWidget) })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(ctx => ({ id: ScopeDeviceWidget.ID, createWidget: () => ctx.container.get(ScopeDeviceWidget) })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(ctx => ({ id: NoduConsoleWidget.ID, createWidget: () => ctx.container.get(NoduConsoleWidget) })).inSingletonScope();
    bindViewContribution(bind, ScopeVisionContribution);
    bindViewContribution(bind, ScopeDeviceContribution);
    bindViewContribution(bind, ScopeConsoleContribution);
    bind(NoduBoardFilesWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({ id: NoduBoardFilesWidget.ID, createWidget: () => ctx.container.get(NoduBoardFilesWidget) })).inSingletonScope();
    bindViewContribution(bind, NoduBoardFilesContribution);
    bind(ScopeThemeContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ScopeThemeContribution);
    bind(ScopeColorContribution).toSelf().inSingletonScope();
    bind(ColorContribution).toService(ScopeColorContribution);
    bind(ScopeWorkbenchContribution).toSelf().inSingletonScope();
    for (const contribution of [FrontendApplicationContribution, CommandContribution, MenuContribution, KeybindingContribution]) {
        bind(contribution).toService(ScopeWorkbenchContribution);
    }
    bind(NoduVisionToolsContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(NoduVisionToolsContribution);
    bind(MenuContribution).toService(NoduVisionToolsContribution);
    bind(NoduFileToolsContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(NoduFileToolsContribution);
    bind(MenuContribution).toService(NoduFileToolsContribution);
    bind(NoduMediaToolsContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(NoduMediaToolsContribution);
    bind(MenuContribution).toService(NoduMediaToolsContribution);
    bind(NoduFileDocsContribution).toSelf().inSingletonScope();
    for (const contribution of [FrontendApplicationContribution, CommandContribution, MenuContribution]) {
        bind(contribution).toService(NoduFileDocsContribution);
    }
    bind(NoduEditorMenusContribution).toSelf().inSingletonScope();
    for (const contribution of [FrontendApplicationContribution, CommandContribution, MenuContribution, KeybindingContribution]) {
        bind(contribution).toService(NoduEditorMenusContribution);
    }
    bind(NoduTerminalContribution).toSelf().inSingletonScope();
    for (const contribution of [FrontendApplicationContribution, CommandContribution, MenuContribution, KeybindingContribution]) {
        bind(contribution).toService(NoduTerminalContribution);
    }
    bind(NoduResources).toSelf().inSingletonScope();
    bind(NoduUpdateContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(NoduUpdateContribution);
    bind(PreferenceContribution).toConstantValue({ schema: NODU_UPDATE_SCHEMA });
});
