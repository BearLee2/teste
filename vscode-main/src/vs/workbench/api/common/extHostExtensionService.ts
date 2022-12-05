/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as path from 'vs/base/common/path';
import * as performance from 'vs/base/common/performance';
import { originalFSPath, joinPath, extUriBiasedIgnorePathCase } from 'vs/base/common/resources';
import { asPromise, Barrier, timeout } from 'vs/base/common/async';
import { dispose, toDisposable, Disposable } from 'vs/base/common/lifecycle';
import { TernarySearchTree } from 'vs/base/common/ternarySearchTree';
import { URI, UriComponents } from 'vs/base/common/uri';
import { ILogService } from 'vs/platform/log/common/log';
import { ExtHostExtensionServiceShape, MainContext, MainThreadExtensionServiceShape, MainThreadTelemetryShape, MainThreadWorkspaceShape } from 'vs/workbench/api/common/extHost.protocol';
import { IExtensionDescriptionDelta, IExtensionHostInitData } from 'vs/workbench/services/extensions/common/extensionHostProtocol';
import { ExtHostConfiguration, IExtHostConfiguration } from 'vs/workbench/api/common/extHostConfiguration';
import { ActivatedExtension, EmptyExtension, ExtensionActivationTimes, ExtensionActivationTimesBuilder, ExtensionsActivator, IExtensionAPI, IExtensionModule, HostExtension, ExtensionActivationTimesFragment } from 'vs/workbench/api/common/extHostExtensionActivator';
import { ExtHostStorage, IExtHostStorage } from 'vs/workbench/api/common/extHostStorage';
import { ExtHostWorkspace, IExtHostWorkspace } from 'vs/workbench/api/common/extHostWorkspace';
import { MissingExtensionDependency, ActivationKind, checkProposedApiEnabled, isProposedApiEnabled, ExtensionActivationReason, extensionIdentifiersArrayToSet } from 'vs/workbench/services/extensions/common/extensions';
import { ExtensionDescriptionRegistry } from 'vs/workbench/services/extensions/common/extensionDescriptionRegistry';
import * as errors from 'vs/base/common/errors';
import type * as vscode from 'vscode';
import { ExtensionIdentifier, IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { VSBuffer } from 'vs/base/common/buffer';
import { ExtensionGlobalMemento, ExtensionMemento } from 'vs/workbench/api/common/extHostMemento';
import { RemoteAuthorityResolverError, ExtensionKind, ExtensionMode, ExtensionRuntime } from 'vs/workbench/api/common/extHostTypes';
import { ResolvedAuthority, ResolvedOptions, RemoteAuthorityResolverErrorCode, IRemoteConnectionData } from 'vs/platform/remote/common/remoteAuthorityResolver';
import { IInstantiationService, createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IExtHostInitDataService } from 'vs/workbench/api/common/extHostInitDataService';
import { IExtensionStoragePaths } from 'vs/workbench/api/common/extHostStoragePaths';
import { IExtHostRpcService } from 'vs/workbench/api/common/extHostRpcService';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { IExtHostTunnelService } from 'vs/workbench/api/common/extHostTunnelService';
import { IExtHostTerminalService } from 'vs/workbench/api/common/extHostTerminalService';
import { Emitter, Event } from 'vs/base/common/event';
import { IExtensionActivationHost, checkActivateWorkspaceContainsExtension } from 'vs/workbench/services/extensions/common/workspaceContains';
import { ExtHostSecretState, IExtHostSecretState } from 'vs/workbench/api/common/extHostSecretState';
import { ExtensionSecrets } from 'vs/workbench/api/common/extHostSecrets';
import { Schemas } from 'vs/base/common/network';
import { IResolveAuthorityResult } from 'vs/workbench/services/extensions/common/extensionHostProxy';
import { IExtHostLocalizationService } from 'vs/workbench/api/common/extHostLocalizationService';

interface ITestRunner {
	/** Old test runner API, as exported from `vscode/lib/testrunner` */
	run(testsRoot: string, clb: (error: Error, failures?: number) => void): void;
}

interface INewTestRunner {
	/** New test runner API, as explained in the extension test doc */
	run(): Promise<void>;
}

export const IHostUtils = createDecorator<IHostUtils>('IHostUtils');

export interface IHostUtils {
	readonly _serviceBrand: undefined;
	readonly pid: number | undefined;
	exit(code: number): void;
	exists(path: string): Promise<boolean>;
	realpath(path: string): Promise<string>;
}

type TelemetryActivationEventFragment = {
	id: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'The identifier of an extension' };
	name: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'The name of the extension' };
	extensionVersion: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'The version of the extension' };
	publisherDisplayName: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The publisher of the extension' };
	activationEvents: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'All activation events of the extension' };
	isBuiltin: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'If the extension is builtin or git installed' };
	reason: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The activation event' };
	reasonId: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'The identifier of the activation event' };
};

export abstract class AbstractExtHostExtensionService extends Disposable implements ExtHostExtensionServiceShape {

	readonly _serviceBrand: undefined;

	abstract readonly extensionRuntime: ExtensionRuntime;

	private readonly _onDidChangeRemoteConnectionData = this._register(new Emitter<void>());
	public readonly onDidChangeRemoteConnectionData = this._onDidChangeRemoteConnectionData.event;

	protected readonly _hostUtils: IHostUtils;
	protected readonly _initData: IExtensionHostInitData;
	protected readonly _extHostContext: IExtHostRpcService;
	protected readonly _instaService: IInstantiationService;
	protected readonly _extHostWorkspace: ExtHostWorkspace;
	protected readonly _extHostConfiguration: ExtHostConfiguration;
	protected readonly _logService: ILogService;
	protected readonly _extHostTunnelService: IExtHostTunnelService;
	protected readonly _extHostTerminalService: IExtHostTerminalService;
	protected readonly _extHostLocalizationService: IExtHostLocalizationService;

	protected readonly _mainThreadWorkspaceProxy: MainThreadWorkspaceShape;
	protected readonly _mainThreadTelemetryProxy: MainThreadTelemetryShape;
	protected readonly _mainThreadExtensionsProxy: MainThreadExtensionServiceShape;

	private readonly _almostReadyToRunExtensions: Barrier;
	private readonly _readyToStartExtensionHost: Barrier;
	private readonly _readyToRunExtensions: Barrier;
	private readonly _eagerExtensionsActivated: Barrier;

	protected readonly _myRegistry: ExtensionDescriptionRegistry;
	protected readonly _globalRegistry: ExtensionDescriptionRegistry;
	private readonly _storage: ExtHostStorage;
	private readonly _secretState: ExtHostSecretState;
	private readonly _storagePath: IExtensionStoragePaths;
	private readonly _activator: ExtensionsActivator;
	private _extensionPathIndex: Promise<ExtensionPaths> | null;

	private readonly _resolvers: { [authorityPrefix: string]: vscode.RemoteAuthorityResolver };

	private _started: boolean;
	private _isTerminating: boolean = false;
	private _remoteConnectionData: IRemoteConnectionData | null;

	constructor(
		@IInstantiationService instaService: IInstantiationService,
		@IHostUtils hostUtils: IHostUtils,
		@IExtHostRpcService extHostContext: IExtHostRpcService,
		@IExtHostWorkspace extHostWorkspace: IExtHostWorkspace,
		@IExtHostConfiguration extHostConfiguration: IExtHostConfiguration,
		@ILogService logService: ILogService,
		@IExtHostInitDataService initData: IExtHostInitDataService,
		@IExtensionStoragePaths storagePath: IExtensionStoragePaths,
		@IExtHostTunnelService extHostTunnelService: IExtHostTunnelService,
		@IExtHostTerminalService extHostTerminalService: IExtHostTerminalService,
		@IExtHostLocalizationService extHostLocalizationService: IExtHostLocalizationService
	) {
		super();
		this._hostUtils = hostUtils;
		this._extHostContext = extHostContext;
		this._initData = initData;

		this._extHostWorkspace = extHostWorkspace;
		this._extHostConfiguration = extHostConfiguration;
		this._logService = logService;
		this._extHostTunnelService = extHostTunnelService;
		this._extHostTerminalService = extHostTerminalService;
		this._extHostLocalizationService = extHostLocalizationService;

		this._mainThreadWorkspaceProxy = this._extHostContext.getProxy(MainContext.MainThreadWorkspace);
		this._mainThreadTelemetryProxy = this._extHostContext.getProxy(MainContext.MainThreadTelemetry);
		this._mainThreadExtensionsProxy = this._extHostContext.getProxy(MainContext.MainThreadExtensionService);

		this._almostReadyToRunExtensions = new Barrier();
		this._readyToStartExtensionHost = new Barrier();
		this._readyToRunExtensions = new Barrier();
		this._eagerExtensionsActivated = new Barrier();
		this._globalRegistry = new ExtensionDescriptionRegistry(this._initData.allExtensions);
		const myExtensionsSet = extensionIdentifiersArrayToSet(this._initData.myExtensions);
		this._myRegistry = new ExtensionDescriptionRegistry(
			filterExtensions(this._globalRegistry, myExtensionsSet)
		);
		this._storage = new ExtHostStorage(this._extHostContext, this._logService);
		this._secretState = new ExtHostSecretState(this._extHostContext);
		this._storagePath = storagePath;

		this._instaService = instaService.createChild(new ServiceCollection(
			[IExtHostStorage, this._storage],
			[IExtHostSecretState, this._secretState]
		));

		const resolvedExtensions = this._initData.allExtensions.filter(extension => !extension.main && !extension.browser).map(extension => extension.identifier);
		const hostExtensions = (
			this._initData.allExtensions
				.filter(extension => !myExtensionsSet.has(ExtensionIdentifier.toKey(extension.identifier.value)))
				.filter(extension => (extension.main || extension.browser) && extension.api === 'none').map(extension => extension.identifier)
		);
		const hostExtensionsSet = extensionIdentifiersArrayToSet(hostExtensions);

		this._activator = this._register(new ExtensionsActivator(
			this._myRegistry,
			resolvedExtensions,
			hostExtensions,
			{
				onExtensionActivationError: (extensionId: ExtensionIdentifier, error: Error, missingExtensionDependency: MissingExtensionDependency | null): void => {
					this._mainThreadExtensionsProxy.$onExtensionActivationError(extensionId, errors.transformErrorForSerialization(error), missingExtensionDependency);
				},

				actualActivateExtension: async (extensionId: ExtensionIdentifier, reason: ExtensionActivationReason): Promise<ActivatedExtension> => {
					if (hostExtensionsSet.has(ExtensionIdentifier.toKey(extensionId))) {
						await this._mainThreadExtensionsProxy.$activateExtension(extensionId, reason);
						return new HostExtension();
					}
					const extensionDescription = this._myRegistry.getExtensionDescription(extensionId)!;
					return this._activateExtension(extensionDescription, reason);
				}
			},
			this._logService
		));
		this._extensionPathIndex = null;
		this._resolvers = Object.create(null);
		this._started = false;
		this._remoteConnectionData = this._initData.remote.connectionData;
	}

	public getRemoteConnectionData(): IRemoteConnectionData | null {
		return this._remoteConnectionData;
	}

	public async initialize(): Promise<void> {
		try {

			await this._beforeAlmostReadyToRunExtensions();
			this._almostReadyToRunExtensions.open();

			await this._extHostWorkspace.waitForInitializeCall();
			performance.mark('code/extHost/ready');
			this._readyToStartExtensionHost.open();

			if (this._initData.autoStart) {
				this._startExtensionHost();
			}
		} catch (err) {
			errors.onUnexpectedError(err);
		}
	}

	private async _deactivateAll(): Promise<void> {
		this._storagePath.onWillDeactivateAll();

		let allPromises: Promise<void>[] = [];
		try {
			const allExtensions = this._myRegistry.getAllExtensionDescriptions();
			const allExtensionsIds = allExtensions.map(ext => ext.identifier);
			const activatedExtensions = allExtensionsIds.filter(id => this.isActivated(id));

			allPromises = activatedExtensions.map((extensionId) => {
				return this._deactivate(extensionId);
			});
		} catch (err) {
			// TODO: write to log once we have one
		}
		await Promise.all(allPromises);
	}

	public terminate(reason: string, code: number = 0): void {
		if (this._isTerminating) {
			// we are already shutting down...
			return;
		}
		this._isTerminating = true;
		this._logService.info(`Extension host terminating: ${reason}`);
		this._logService.flush();

		this._extHostTerminalService.dispose();
		this._activator.dispose();

		errors.setUnexpectedErrorHandler((err) => {
			this._logService.error(err);
		});

		// Invalidate all proxies
		this._extHostContext.dispose();

		const extensionsDeactivated = this._deactivateAll();

		// Give extensions at most 5 seconds to wrap up any async deactivate, then exit
		Promise.race([timeout(5000), extensionsDeactivated]).finally(() => {
			if (this._hostUtils.pid) {
				this._logService.info(`Extension host with pid ${this._hostUtils.pid} exiting with code ${code}`);
			} else {
				this._logService.info(`Extension host exiting with code ${code}`);
			}
			this._logService.flush();
			this._logService.dispose();
			this._hostUtils.exit(code);
		});
	}

	public isActivated(extensionId: ExtensionIdentifier): boolean {
		if (this._readyToRunExtensions.isOpen()) {
			return this._activator.isActivated(extensionId);
		}
		return false;
	}

	public async getExtension(extensionId: string): Promise<IExtensionDescription | undefined> {
		const ext = await this._mainThreadExtensionsProxy.$getExtension(extensionId);
		let browserNlsBundleUris: { [language: string]: URI } | undefined;
		if (ext?.browserNlsBundleUris) {
			browserNlsBundleUris = {};
			for (const language of Object.keys(ext.browserNlsBundleUris)) {
				browserNlsBundleUris[language] = URI.revive(ext.browserNlsBundleUris[language]);
			}
		}
		return ext && {
			...ext,
			identifier: new ExtensionIdentifier(ext.identifier.value),
			extensionLocation: URI.revive(ext.extensionLocation),
			browserNlsBundleUris
		};
	}

	private _activateByEvent(activationEvent: string, startup: boolean): Promise<void> {
		return this._activator.activateByEvent(activationEvent, startup);
	}

	private _activateById(extensionId: ExtensionIdentifier, reason: ExtensionActivationReason): Promise<void> {
		return this._activator.activateById(extensionId, reason);
	}

	public activateByIdWithErrors(extensionId: ExtensionIdentifier, reason: ExtensionActivationReason): Promise<void> {
		return this._activateById(extensionId, reason).then(() => {
			const extension = this._activator.getActivatedExtension(extensionId);
			if (extension.activationFailed) {
				// activation failed => bubble up the error as the promise result
				return Promise.reject(extension.activationFailedError);
			}
			return undefined;
		});
	}

	public getExtensionRegistry(): Promise<ExtensionDescriptionRegistry> {
		return this._readyToRunExtensions.wait().then(_ => this._myRegistry);
	}

	public getExtensionExports(extensionId: ExtensionIdentifier): IExtensionAPI | null | undefined {
		if (this._readyToRunExtensions.isOpen()) {
			return this._activator.getActivatedExtension(extensionId).exports;
		} else {
			return null;
		}
	}

	/**
	 * Applies realpath to file-uris and returns all others uris unmodified
	 */
	private async _realPathExtensionUri(uri: URI): Promise<URI> {
		if (uri.scheme !== Schemas.file) {
			return uri;
		}
		const realpathValue = await this._hostUtils.realpath(uri.fsPath);
		return URI.file(realpathValue);
	}

	// create trie to enable fast 'filename -> extension id' look up
	public async getExtensionPathIndex(): Promise<ExtensionPaths> {
		if (!this._extensionPathIndex) {
			this._extensionPathIndex = this._createExtensionPathIndex(this._myRegistry.getAllExtensionDescriptions()).then((searchTree) => {
				return new ExtensionPaths(searchTree);
			});
		}
		return this._extensionPathIndex;
	}

	/**
	 * create trie to enable fast 'filename -> extension id' look up
	 */
	private async _createExtensionPathIndex(extensions: IExtensionDescription[]): Promise<TernarySearchTree<URI, IExtensionDescription>> {
		const tst = TernarySearchTree.forUris<IExtensionDescription>(key => {
			// using the default/biased extUri-util because the IExtHostFileSystemInfo-service
			// isn't ready to be used yet, e.g the knowledge about `file` protocol and others
			// comes in while this code runs
			return extUriBiasedIgnorePathCase.ignorePathCasing(key);
		});
		// const tst = TernarySearchTree.forUris<IExtensionDescription>(key => true);
		await Promise.all(extensions.map(async (ext) => {
			if (this._getEntryPoint(ext)) {
				const uri = await this._realPathExtensionUri(ext.extensionLocation);
				tst.set(uri, ext);
			}
		}));
		return tst;
	}

	private _deactivate(extensionId: ExtensionIdentifier): Promise<void> {
		let result = Promise.resolve(undefined);

		if (!this._readyToRunExtensions.isOpen()) {
			return result;
		}

		if (!this._activator.isActivated(extensionId)) {
			return result;
		}

		const extension = this._activator.getActivatedExtension(extensionId);
		if (!extension) {
			return result;
		}

		// call deactivate if available
		try {
			if (typeof extension.module.deactivate === 'function') {
				result = Promise.resolve(extension.module.deactivate()).then(undefined, (err) => {
					this._logService.error(err);
					return Promise.resolve(undefined);
				});
			}
		} catch (err) {
			this._logService.error(`An error occurred when deactivating the extension '${extensionId.value}':`);
			this._logService.error(err);
		}

		// clean up subscriptions
		try {
			dispose(extension.subscriptions);
		} catch (err) {
			this._logService.error(`An error occurred when deactivating the subscriptions for extension '${extensionId.value}':`);
			this._logService.error(err);
		}

		return result;
	}

	// --- impl

	private async _activateExtension(extensionDescription: IExtensionDescription, reason: ExtensionActivationReason): Promise<ActivatedExtension> {
		if (!this._initData.remote.isRemote) {
			// local extension host process
			await this._mainThreadExtensionsProxy.$onWillActivateExtension(extensionDescription.identifier);
		} else {
			// remote extension host process
			// do not wait for renderer confirmation
			this._mainThreadExtensionsProxy.$onWillActivateExtension(extensionDescription.identifier);
		}
		return this._doActivateExtension(extensionDescription, reason).then((activatedExtension) => {
			const activationTimes = activatedExtension.activationTimes;
			this._mainThreadExtensionsProxy.$onDidActivateExtension(extensionDescription.identifier, activationTimes.codeLoadingTime, activationTimes.activateCallTime, activationTimes.activateResolvedTime, reason);
			this._logExtensionActivationTimes(extensionDescription, reason, 'success', activationTimes);
			return activatedExtension;
		}, (err) => {
			this._logExtensionActivationTimes(extensionDescription, reason, 'failure');
			throw err;
		});
	}

	private _logExtensionActivationTimes(extensionDescription: IExtensionDescription, reason: ExtensionActivationReason, outcome: string, activationTimes?: ExtensionActivationTimes) {
		const event = getTelemetryActivationEvent(extensionDescription, reason);
		type ExtensionActivationTimesClassification = {
			owner: 'jrieken';
			comment: 'Timestamps for extension activation';
			outcome: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Did extension activation succeed or fail' };
		} & TelemetryActivationEventFragment & ExtensionActivationTimesFragment;

		type ExtensionActivationTimesEvent = {
			outcome: string;
		} & ActivationTimesEvent & TelemetryActivationEvent;

		type ActivationTimesEvent = {
			startup?: boolean;
			codeLoadingTime?: number;
			activateCallTime?: number;
			activateResolvedTime?: number;
		};

		this._mainThreadTelemetryProxy.$publicLog2<ExtensionActivationTimesEvent, ExtensionActivationTimesClassification>('extensionActivationTimes', {
			...event,
			...(activationTimes || {}),
			outcome
		});
	}

	private _doActivateExtension(extensionDescription: IExtensionDescription, reason: ExtensionActivationReason): Promise<ActivatedExtension> {
		const event = getTelemetryActivationEvent(extensionDescription, reason);
		type ActivatePluginClassification = {
			owner: 'jrieken';
			comment: 'Data about how/why an extension was activated';
		} & TelemetryActivationEventFragment;
		this._mainThreadTelemetryProxy.$publicLog2<TelemetryActivationEvent, ActivatePluginClassification>('activatePlugin', event);
		const entryPoint = this._getEntryPoint(extensionDescription);
		if (!entryPoint) {
			// Treat the extension as being empty => NOT AN ERROR CASE
			return Promise.resolve(new EmptyExtension(ExtensionActivationTimes.NONE));
		}

		this._logService.info(`ExtensionService#_doActivateExtension ${extensionDescription.identifier.value}, startup: ${reason.startup}, activationEvent: '${reason.activationEvent}'${extensionDescription.identifier.value !== reason.extensionId.value ? `, root cause: ${reason.extensionId.value}` : ``}`);
		this._logService.flush();

		const activationTimesBuilder = new ExtensionActivationTimesBuilder(reason.startup);
		return Promise.all([
			this._loadCommonJSModule<IExtensionModule>(extensionDescription, joinPath(extensionDescription.extensionLocation, entryPoint), activationTimesBuilder),
			this._loadExtensionContext(extensionDescription)
		]).then(values => {
			performance.mark(`code/extHost/willActivateExtension/${extensionDescription.identifier.value}`);
			return AbstractExtHostExtensionService._callActivate(this._logService, extensionDescription.identifier, values[0], values[1], activationTimesBuilder);
		}).then((activatedExtension) => {
			performance.mark(`code/extHost/didActivateExtension/${extensionDescription.identifier.value}`);
			return activatedExtension;
		});
	}

	private _loadExtensionContext(extensionDescription: IExtensionDescription): Promise<vscode.ExtensionContext> {

		const globalState = new ExtensionGlobalMemento(extensionDescription, this._storage);
		const workspaceState = new ExtensionMemento(extensionDescription.identifier.value, false, this._storage);
		const secrets = new ExtensionSecrets(extensionDescription, this._secretState);
		const extensionMode = extensionDescription.isUnderDevelopment
			? (this._initData.environment.extensionTestsLocationURI ? ExtensionMode.Test : ExtensionMode.Development)
			: ExtensionMode.Production;
		const extensionKind = this._initData.remote.isRemote ? ExtensionKind.Workspace : ExtensionKind.UI;

		this._logService.trace(`ExtensionService#loadExtensionContext ${extensionDescription.identifier.value}`);

		return Promise.all([
			globalState.whenReady,
			workspaceState.whenReady,
			this._storagePath.whenReady
		]).then(() => {
			const that = this;
			let extension: vscode.Extension<any> | undefined;

			let messagePassingProtocol: vscode.MessagePassingProtocol | undefined;
			const messagePort = isProposedApiEnabled(extensionDescription, 'ipc')
				? this._initData.messagePorts?.get(ExtensionIdentifier.toKey(extensionDescription.identifier))
				: undefined;

			return Object.freeze<vscode.ExtensionContext>({
				globalState,
				workspaceState,
				secrets,
				subscriptions: [],
				get extensionUri() { return extensionDescription.extensionLocation; },
				get extensionPath() { return extensionDescription.extensionLocation.fsPath; },
				asAbsolutePath(relativePath: string) { return path.join(extensionDescription.extensionLocation.fsPath, relativePath); },
				get storagePath() { return that._storagePath.workspaceValue(extensionDescription)?.fsPath; },
				get globalStoragePath() { return that._storagePath.globalValue(extensionDescription).fsPath; },
				get logPath() { return path.join(that._initData.logsLocation.fsPath, extensionDescription.identifier.value); },
				get logUri() { return URI.joinPath(that._initData.logsLocation, extensionDescription.identifier.value); },
				get storageUri() { return that._storagePath.workspaceValue(extensionDescription); },
				get globalStorageUri() { return that._storagePath.globalValue(extensionDescription); },
				get extensionMode() { return extensionMode; },
				get extension() {
					if (extension === undefined) {
						extension = new Extension(that, extensionDescription.identifier, extensionDescription, extensionKind, false);
					}
					return extension;
				},
				get extensionRuntime() {
					checkProposedApiEnabled(extensionDescription, 'extensionRuntime');
					return that.extensionRuntime;
				},
				get environmentVariableCollection() { return that._extHostTerminalService.getEnvironmentVariableCollection(extensionDescription); },
				get messagePassingProtocol() {
					if (!messagePassingProtocol) {
						if (!messagePort) {
							return undefined;
						}

						const onDidReceiveMessage = Event.buffer(Event.fromDOMEventEmitter(messagePort, 'message', e => e.data));
						messagePort.start();
						messagePassingProtocol = {
							onDidReceiveMessage,
							postMessage: messagePort.postMessage.bind(messagePort) as any
						};
					}

					return messagePassingProtocol;
				}
			});
		});
	}

	private static _callActivate(logService: ILogService, extensionId: ExtensionIdentifier, extensionModule: IExtensionModule, context: vscode.ExtensionContext, activationTimesBuilder: ExtensionActivationTimesBuilder): Promise<ActivatedExtension> {
		// Make sure the extension's surface is not undefined
		extensionModule = extensionModule || {
			activate: undefined,
			deactivate: undefined
		};

		return this._callActivateOptional(logService, extensionId, extensionModule, context, activationTimesBuilder).then((extensionExports) => {
			return new ActivatedExtension(false, null, activationTimesBuilder.build(), extensionModule, extensionExports, context.subscriptions);
		});
	}

	private static _callActivateOptional(logService: ILogService, extensionId: ExtensionIdentifier, extensionModule: IExtensionModule, context: vscode.ExtensionContext, activationTimesBuilder: ExtensionActivationTimesBuilder): Promise<IExtensionAPI> {
		if (typeof extensionModule.activate === 'function') {
			try {
				activationTimesBuilder.activateCallStart();
				logService.trace(`ExtensionService#_callActivateOptional ${extensionId.value}`);
				const scope = typeof global === 'object' ? global : self; // `global` is nodejs while `self` is for workers
				const activateResult: Promise<IExtensionAPI> = extensionModule.activate.apply(scope, [context]);
				activationTimesBuilder.activateCallStop();

				activationTimesBuilder.activateResolveStart();
				return Promise.resolve(activateResult).then((value) => {
					activationTimesBuilder.activateResolveStop();
					return value;
				});
			} catch (err) {
				return Promise.reject(err);
			}
		} else {
			// No activate found => the module is the extension's exports
			return Promise.resolve<IExtensionAPI>(extensionModule);
		}
	}

	// -- eager activation

	private _activateOneStartupFinished(desc: IExtensionDescription, activationEvent: string): void {
		this._activateById(desc.identifier, {
			startup: false,
			extensionId: desc.identifier,
			activationEvent: activationEvent
		}).then(undefined, (err) => {
			this._logService.error(err);
		});
	}

	private _activateAllStartupFinished(): void {
		// startup is considered finished
		this._mainThreadExtensionsProxy.$setPerformanceMarks(performance.getMarks());

		for (const desc of this._myRegistry.getAllExtensionDescriptions()) {
			if (desc.activationEvents) {
				for (const activationEvent of desc.activationEvents) {
					if (activationEvent === 'onStartupFinished') {
						this._activateOneStartupFinished(desc, activationEvent);
					}
				}
			}
		}
	}

	// Handle "eager" activation extensions
	private _handleEagerExtensions(): Promise<void> {
		const starActivation = this._activateByEvent('*', true).then(undefined, (err) => {
			this._logService.error(err);
		});

		this._register(this._extHostWorkspace.onDidChangeWorkspace((e) => this._handleWorkspaceContainsEagerExtensions(e.added)));
		const folders = this._extHostWorkspace.workspace ? this._extHostWorkspace.workspace.folders : [];
		const workspaceContainsActivation = this._handleWorkspaceContainsEagerExtensions(folders);
		const eagerExtensionsActivation = Promise.all([starActivation, workspaceContainsActivation]).then(() => { });

		Promise.race([eagerExtensionsActivation, timeout(10000)]).then(() => {
			this._activateAllStartupFinished();
		});

		return eagerExtensionsActivation;
	}

	private _handleWorkspaceContainsEagerExtensions(folders: ReadonlyArray<vscode.WorkspaceFolder>): Promise<void> {
		if (folders.length === 0) {
			return Promise.resolve(undefined);
		}

		return Promise.all(
			this._myRegistry.getAllExtensionDescriptions().map((desc) => {
				return this._handleWorkspaceContainsEagerExtension(folders, desc);
			})
		).then(() => { });
	}

	private async _handleWorkspaceContainsEagerExtension(folders: ReadonlyArray<vscode.WorkspaceFolder>, desc: IExtensionDescription): Promise<void> {
		if (this.isActivated(desc.identifier)) {
			return;
		}

		const localWithRemote = !this._initData.remote.isRemote && !!this._initData.remote.authority;
		const host: IExtensionActivationHost = {
			logService: this._logService,
			folders: folders.map(folder => folder.uri),
			forceUsingSearch: localWithRemote,
			exists: (uri) => this._hostUtils.exists(uri.fsPath),
			checkExists: (folders, includes, token) => this._mainThreadWorkspaceProxy.$checkExists(folders, includes, token)
		};

		const result = await checkActivateWorkspaceContainsExtension(host, desc);
		if (!result) {
			return;
		}

		return (
			this._activateById(desc.identifier, { startup: true, extensionId: desc.identifier, activationEvent: result.activationEvent })
				.then(undefined, err => this._logService.error(err))
		);
	}

	public async $extensionTestsExecute(): Promise<number> {
		await this._eagerExtensionsActivated.wait();
		try {
			return await this._doHandleExtensionTests();
		} catch (error) {
			console.error(error); // ensure any error message makes it onto the console
			throw error;
		}
	}

	private async _doHandleExtensionTests(): Promise<number> {
		const { extensionDevelopmentLocationURI, extensionTestsLocationURI } = this._initData.environment;
		if (!extensionDevelopmentLocationURI || !extensionTestsLocationURI) {
			throw new Error(nls.localize('extensionTestError1', "Cannot load test runner."));
		}

		// Require the test runner via node require from the provided path
		const testRunner = await this._loadCommonJSModule<ITestRunner | INewTestRunner | undefined>(null, extensionTestsLocationURI, new ExtensionActivationTimesBuilder(false));

		if (!testRunner || typeof testRunner.run !== 'function') {
			throw new Error(nls.localize('extensionTestError', "Path {0} does not point to a valid extension test runner.", extensionTestsLocationURI.toString()));
		}

		// Execute the runner if it follows the old `run` spec
		return new Promise<number>((resolve, reject) => {
			const oldTestRunnerCallback = (error: Error, failures: number | undefined) => {
				if (error) {
					reject(error);
				} else {
					resolve((typeof failures === 'number' && failures > 0) ? 1 /* ERROR */ : 0 /* OK */);
				}
			};

			const extensionTestsPath = originalFSPath(extensionTestsLocationURI); // for the old test runner API

			const runResult = testRunner.run(extensionTestsPath, oldTestRunnerCallback);

			// Using the new API `run(): Promise<void>`
			if (runResult && runResult.then) {
				runResult
					.then(() => {
						resolve(0);
					})
					.catch((err: unknown) => {
						reject(err instanceof Error && err.stack ? err.stack : String(err));
					});
			}
		});
	}

	private _startExtensionHost(): Promise<void> {
		if (this._started) {
			throw new Error(`Extension host is already started!`);
		}
		this._started = true;

		return this._readyToStartExtensionHost.wait()
			.then(() => this._readyToRunExtensions.open())
			.then(() => this._handleEagerExtensions())
			.then(() => {
				this._eagerExtensionsActivated.open();
				this._logService.info(`Eager extensions activated`);
			});
	}

	// -- called by extensions

	public registerRemoteAuthorityResolver(authorityPrefix: string, resolver: vscode.RemoteAuthorityResolver): vscode.Disposable {
		this._resolvers[authorityPrefix] = resolver;
		return toDisposable(() => {
			delete this._resolvers[authorityPrefix];
		});
	}

	// -- called by main thread

	private async _activateAndGetResolver(remoteAuthority: string): Promise<{ authorityPrefix: string; resolver: vscode.RemoteAuthorityResolver | undefined }> {
		const authorityPlusIndex = remoteAuthority.indexOf('+');
		if (authorityPlusIndex === -1) {
			throw new Error(`Not an authority that can be resolved!`);
		}
		const authorityPrefix = remoteAuthority.substr(0, authorityPlusIndex);

		await this._almostReadyToRunExtensions.wait();
		await this._activateByEvent(`onResolveRemoteAuthority:${authorityPrefix}`, false);

		return { authorityPrefix, resolver: this._resolvers[authorityPrefix] };
	}

	public async $resolveAuthority(remoteAuthority: string, resolveAttempt: number): Promise<IResolveAuthorityResult> {
		this._logService.info(`$resolveAuthority invoked for authority (${getRemoteAuthorityPrefix(remoteAuthority)})`);

		const { authorityPrefix, resolver } = await this._activateAndGetResolver(remoteAuthority);
		if (!resolver) {
			return {
				type: 'error',
				error: {
					code: RemoteAuthorityResolverErrorCode.NoResolverFound,
					message: `No remote extension installed to resolve ${authorityPrefix}.`,
					detail: undefined
				}
			};
		}

		try {
			this._register(await this._extHostTunnelService.setTunnelFactory(resolver));
			performance.mark(`code/extHost/willResolveAuthority/${authorityPrefix}`);
			const result = await resolver.resolve(remoteAuthority, { resolveAttempt });
			performance.mark(`code/extHost/didResolveAuthorityOK/${authorityPrefix}`);

			// Split merged API result into separate authority/options
			const authority: ResolvedAuthority = {
				authority: remoteAuthority,
				host: result.host,
				port: result.port,
				connectionToken: result.connectionToken
			};
			const options: ResolvedOptions = {
				extensionHostEnv: result.extensionHostEnv,
				isTrusted: result.isTrusted,
				authenticationSession: result.authenticationSessionForInitializingExtensions ? { id: result.authenticationSessionForInitializingExtensions.id, providerId: result.authenticationSessionForInitializingExtensions.providerId } : undefined
			};

			return {
				type: 'ok',
				value: {
					authority,
					options,
					tunnelInformation: {
						environmentTunnels: result.environmentTunnels,
						features: result.tunnelFeatures
					}
				}
			};
		} catch (err) {
			performance.mark(`code/extHost/didResolveAuthorityError/${authorityPrefix}`);
			if (err instanceof RemoteAuthorityResolverError) {
				return {
					type: 'error',
					error: {
						code: err._code,
						message: err._message,
						detail: err._detail
					}
				};
			}
			throw err;
		}
	}

	public async $getCanonicalURI(remoteAuthority: string, uriComponents: UriComponents): Promise<UriComponents | null> {
		this._logService.info(`$getCanonicalURI invoked for authority (${getRemoteAuthorityPrefix(remoteAuthority)})`);

		const { resolver } = await this._activateAndGetResolver(remoteAuthority);
		if (!resolver) {
			// Return `null` if no resolver for `remoteAuthority` is found.
			return null;
		}

		const uri = URI.revive(uriComponents);

		if (typeof resolver.getCanonicalURI === 'undefined') {
			// resolver cannot compute canonical URI
			return uri;
		}

		const result = await asPromise(() => resolver.getCanonicalURI!(uri));
		if (!result) {
			return uri;
		}

		return result;
	}

	private static _applyExtensionsDelta(oldGlobalRegistry: ExtensionDescriptionRegistry, oldMyRegistry: ExtensionDescriptionRegistry, extensionsDelta: IExtensionDescriptionDelta) {
		const globalRegistry = new ExtensionDescriptionRegistry(oldGlobalRegistry.getAllExtensionDescriptions());
		globalRegistry.deltaExtensions(extensionsDelta.toAdd, extensionsDelta.toRemove);

		const myExtensionsSet = extensionIdentifiersArrayToSet(oldMyRegistry.getAllExtensionDescriptions().map(extension => extension.identifier));
		for (const extensionId of extensionsDelta.myToRemove) {
			myExtensionsSet.delete(ExtensionIdentifier.toKey(extensionId));
		}
		for (const extensionId of extensionsDelta.myToAdd) {
			myExtensionsSet.add(ExtensionIdentifier.toKey(extensionId));
		}
		const myExtensions = filterExtensions(globalRegistry, myExtensionsSet);

		return { globalRegistry, myExtensions };
	}

	public $startExtensionHost(extensionsDelta: IExtensionDescriptionDelta): Promise<void> {
		extensionsDelta.toAdd.forEach((extension) => (<any>extension).extensionLocation = URI.revive(extension.extensionLocation));

		const { globalRegistry, myExtensions } = AbstractExtHostExtensionService._applyExtensionsDelta(this._globalRegistry, this._myRegistry, extensionsDelta);
		this._globalRegistry.set(globalRegistry.getAllExtensionDescriptions());
		this._myRegistry.set(myExtensions);

		return this._startExtensionHost();
	}

	public $activateByEvent(activationEvent: string, activationKind: ActivationKind): Promise<void> {
		if (activationKind === ActivationKind.Immediate) {
			return this._activateByEvent(activationEvent, false);
		}

		return (
			this._readyToRunExtensions.wait()
				.then(_ => this._activateByEvent(activationEvent, false))
		);
	}

	public async $activate(extensionId: ExtensionIdentifier, reason: ExtensionActivationReason): Promise<boolean> {
		await this._readyToRunExtensions.wait();
		if (!this._myRegistry.getExtensionDescription(extensionId)) {
			// unknown extension => ignore
			return false;
		}
		await this._activateById(extensionId, reason);
		return true;
	}

	public async $deltaExtensions(extensionsDelta: IExtensionDescriptionDelta): Promise<void> {
		extensionsDelta.toAdd.forEach((extension) => (<any>extension).extensionLocation = URI.revive(extension.extensionLocation));

		// First build up and update the trie and only afterwards apply the delta
		const { globalRegistry, myExtensions } = AbstractExtHostExtensionService._applyExtensionsDelta(this._globalRegistry, this._myRegistry, extensionsDelta);
		const newSearchTree = await this._createExtensionPathIndex(myExtensions);
		const extensionsPaths = await this.getExtensionPathIndex();
		extensionsPaths.setSearchTree(newSearchTree);
		this._globalRegistry.set(globalRegistry.getAllExtensionDescriptions());
		this._myRegistry.set(myExtensions);

		return Promise.resolve(undefined);
	}

	public async $test_latency(n: number): Promise<number> {
		return n;
	}

	public async $test_up(b: VSBuffer): Promise<number> {
		return b.byteLength;
	}

	public async $test_down(size: number): Promise<VSBuffer> {
		const buff = VSBuffer.alloc(size);
		const value = Math.random() % 256;
		for (let i = 0; i < size; i++) {
			buff.writeUInt8(value, i);
		}
		return buff;
	}

	public async $updateRemoteConnectionData(connectionData: IRemoteConnectionData): Promise<void> {
		this._remoteConnectionData = connectionData;
		this._onDidChangeRemoteConnectionData.fire();
	}

	protected abstract _beforeAlmostReadyToRunExtensions(): Promise<void>;
	protected abstract _getEntryPoint(extensionDescription: IExtensionDescription): string | undefined;
	protected abstract _loadCommonJSModule<T extends object | undefined>(extensionId: IExtensionDescription | null, module: URI, activationTimesBuilder: ExtensionActivationTimesBuilder): Promise<T>;
	public abstract $setRemoteEnvironment(env: { [key: string]: string | null }): Promise<void>;
}


type TelemetryActivationEvent = {
	id: string;
	name: string;
	extensionVersion: string;
	publisherDisplayName: string;
	activationEvents: string | null;
	isBuiltin: boolean;
	reason: string;
	reasonId: string;
};

function getTelemetryActivationEvent(extensionDescription: IExtensionDescription, reason: ExtensionActivationReason): TelemetryActivationEvent {
	const event = {
		id: extensionDescription.identifier.value,
		name: extensionDescription.name,
		extensionVersion: extensionDescription.version,
		publisherDisplayName: extensionDescription.publisher,
		activationEvents: extensionDescription.activationEvents ? extensionDescription.activationEvents.join(',') : null,
		isBuiltin: extensionDescription.isBuiltin,
		reason: reason.activationEvent,
		reasonId: reason.extensionId.value,
	};

	return event;
}


export const IExtHostExtensionService = createDecorator<IExtHostExtensionService>('IExtHostExtensionService');

export interface IExtHostExtensionService extends AbstractExtHostExtensionService {
	readonly _serviceBrand: undefined;
	initialize(): Promise<void>;
	terminate(reason: string): void;
	getExtension(extensionId: string): Promise<IExtensionDescription | undefined>;
	isActivated(extensionId: ExtensionIdentifier): boolean;
	activateByIdWithErrors(extensionId: ExtensionIdentifier, reason: ExtensionActivationReason): Promise<void>;
	getExtensionExports(extensionId: ExtensionIdentifier): IExtensionAPI | null | undefined;
	getExtensionRegistry(): Promise<ExtensionDescriptionRegistry>;
	getExtensionPathIndex(): Promise<ExtensionPaths>;
	registerRemoteAuthorityResolver(authorityPrefix: string, resolver: vscode.RemoteAuthorityResolver): vscode.Disposable;

	onDidChangeRemoteConnectionData: Event<void>;
	getRemoteConnectionData(): IRemoteConnectionData | null;
}

export class Extension<T extends object | null | undefined> implements vscode.Extension<T> {

	#extensionService: IExtHostExtensionService;
	#originExtensionId: ExtensionIdentifier;
	#identifier: ExtensionIdentifier;

	readonly id: string;
	readonly extensionUri: URI;
	readonly extensionPath: string;
	readonly packageJSON: IExtensionDescription;
	readonly extensionKind: vscode.ExtensionKind;
	readonly isFromDifferentExtensionHost: boolean;

	constructor(extensionService: IExtHostExtensionService, originExtensionId: ExtensionIdentifier, description: IExtensionDescription, kind: ExtensionKind, isFromDifferentExtensionHost: boolean) {
		this.#extensionService = extensionService;
		this.#originExtensionId = originExtensionId;
		this.#identifier = description.identifier;
		this.id = description.identifier.value;
		this.extensionUri = description.extensionLocation;
		this.extensionPath = path.normalize(originalFSPath(description.extensionLocation));
		this.packageJSON = description;
		this.extensionKind = kind;
		this.isFromDifferentExtensionHost = isFromDifferentExtensionHost;
	}

	get isActive(): boolean {
		// TODO@alexdima support this
		return this.#extensionService.isActivated(this.#identifier);
	}

	get exports(): T {
		if (this.packageJSON.api === 'none' || this.isFromDifferentExtensionHost) {
			return undefined!; // Strict nulloverride - Public api
		}
		return <T>this.#extensionService.getExtensionExports(this.#identifier);
	}

	async activate(): Promise<T> {
		if (this.isFromDifferentExtensionHost) {
			throw new Error('Cannot activate foreign extension'); // TODO@alexdima support this
		}
		await this.#extensionService.activateByIdWithErrors(this.#identifier, { startup: false, extensionId: this.#originExtensionId, activationEvent: 'api' });
		return this.exports;
	}
}

function filterExtensions(globalRegistry: ExtensionDescriptionRegistry, desiredExtensions: Set<string>): IExtensionDescription[] {
	return globalRegistry.getAllExtensionDescriptions().filter(
		extension => desiredExtensions.has(ExtensionIdentifier.toKey(extension.identifier))
	);
}

function getRemoteAuthorityPrefix(remoteAuthority: string): string {
	const plusIndex = remoteAuthority.indexOf('+');
	if (plusIndex === -1) {
		return remoteAuthority;
	}
	return remoteAuthority.substring(0, plusIndex);
}

export class ExtensionPaths {

	constructor(
		private _searchTree: TernarySearchTree<URI, IExtensionDescription>
	) { }

	setSearchTree(searchTree: TernarySearchTree<URI, IExtensionDescription>): void {
		this._searchTree = searchTree;
	}

	findSubstr(key: URI): IExtensionDescription | undefined {
		return this._searchTree.findSubstr(key);
	}

	forEach(callback: (value: IExtensionDescription, index: URI) => any): void {
		return this._searchTree.forEach(callback);
	}
}