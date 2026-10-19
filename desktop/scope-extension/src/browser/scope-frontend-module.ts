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
import { NoduDeviceModel } from './nodu-device-client';
import { NoduConsoleWidget } from './nodu-console-widget';
import { ScopeConsoleContribution } from './scope-workbench';
import '../../style/scope.css';
import '../../style/widgets.css';
import '../../style/layout.css';
import '../../style/device.css';

export default new ContainerModule(bind => {
    bind(NoduDeviceModel).toSelf().inSingletonScope();
    bind(ScopeSession).toSelf().inSingletonScope();
    bind(ScopeLayoutState).toSelf().inSingletonScope();
    bind(ScopeToolbar).toSelf().inSingletonScope();
    bind(ScopeVisionWidget).toSelf();
    bind(ScopeDeviceWidget).toSelf();
    bind(NoduConsoleWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({ id: ScopeVisionWidget.ID, createWidget: () => ctx.container.get(ScopeVisionWidget) })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(ctx => ({ id: ScopeDeviceWidget.ID, createWidget: () => ctx.container.get(ScopeDeviceWidget) })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(ctx => ({ id: NoduConsoleWidget.ID, createWidget: () => ctx.container.get(NoduConsoleWidget) })).inSingletonScope();
    bindViewContribution(bind, ScopeVisionContribution);
    bindViewContribution(bind, ScopeDeviceContribution);
    bindViewContribution(bind, ScopeConsoleContribution);
    bind(ScopeThemeContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ScopeThemeContribution);
    bind(ScopeColorContribution).toSelf().inSingletonScope();
    bind(ColorContribution).toService(ScopeColorContribution);
    bind(ScopeWorkbenchContribution).toSelf().inSingletonScope();
    for (const contribution of [FrontendApplicationContribution, CommandContribution, MenuContribution, KeybindingContribution]) {
        bind(contribution).toService(ScopeWorkbenchContribution);
    }
});
