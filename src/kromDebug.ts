import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { MockRuntime, MockBreakpoint } from './mockRuntime';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as source_map from 'source-map';
const { Subject } = require('await-notify');

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program?: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	projectDir: string;
}

export class KromDebugSession extends LoggingDebugSession {
	private static DEBUGGER_MESSAGE_BREAKPOINT = 0;
	private static DEBUGGER_MESSAGE_PAUSE = 1;
	private static DEBUGGER_MESSAGE_STACKTRACE = 2;
	private static DEBUGGER_MESSAGE_CONTINUE = 3;
	private static DEBUGGER_MESSAGE_STEP_OVER = 4;
	private static DEBUGGER_MESSAGE_STEP_IN = 5;
	private static DEBUGGER_MESSAGE_STEP_OUT = 6;

	private static IDE_MESSAGE_STACKTRACE = 0;
	private static IDE_MESSAGE_BREAK = 1;
	//private static IDE_MESSAGE_VARIABLES = 2;

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	// a Mock runtime (or debugger)
	private _runtime: MockRuntime;

	private _variableHandles = new Handles<string>();

	private _configurationDone = new Subject();

	private sourceMap: source_map.SourceMapConsumer;

	private socket: net.Socket;

	private pendingResponses: Map<number, DebugProtocol.Response> = new Map();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super("mock-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this._runtime = new MockRuntime();

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', KromDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', KromDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', KromDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnException', () => {
			this.sendEvent(new StoppedEvent('exception', KromDebugSession.THREAD_ID));
		});
		this._runtime.on('breakpointValidated', (bp: MockBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.verified, id: bp.id }));
		});
		this._runtime.on('output', (text, filePath, line, column) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = true;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		//logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);
		logger.setup(Logger.LogLevel.Verbose, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		logger.log('Connecting...');

		this.sourceMap = await new source_map.SourceMapConsumer(fs.readFileSync(path.join(args.projectDir, 'build', 'krom', 'krom.js.temp.map'), 'utf8'));

		this.socket = net.connect(9191, 'localhost', () => {
			logger.log('Connected');
			this.sendResponse(response);
		});

		this.socket.on('data', (data) => {
			logger.log('Receiving data.');
			if (data.readInt32LE(0) === KromDebugSession.IDE_MESSAGE_STACKTRACE) {
				let ii = 4;
				let frames: any[] = [];
				let responseId = data.readInt32LE(ii); ii += 4;
				logger.log('Receiving a stack trace for response ' + responseId + '.');
				let length = data.readInt32LE(ii); ii += 4;
				logger.log('Stack frame length is ' + length);
				for (let i = 0; i < length; ++i) {
					const index = data.readInt32LE(ii); ii += 4;
					const scriptId = data.readInt32LE(ii); ii += 4;
					let line = data.readInt32LE(ii); ii += 4;
					let column = data.readInt32LE(ii); ii += 4;
					const sourceLength = data.readInt32LE(ii); ii += 4;
					const functionHandle = data.readInt32LE(ii); ii += 4;
					const stringLength = data.readInt32LE(ii); ii += 4;
					let str = '';
					for (let j = 0; j < stringLength; ++j) {
						str += String.fromCharCode(data.readInt32LE(ii)); ii += 4;
					}

					const original = this.sourceMap.originalPositionFor({ line: line, column: column });

					frames.push({
						index: index,
						scriptId: scriptId,
						line: line,
						column: column,
						sourceLength: sourceLength,
						functionHandle: functionHandle,
						sourceText: str,
						originalLine: original.line,
						originalColumn: original.column,
						originalSource: original.source,
						originalName: original.name
					});
				}
				let response = this.pendingResponses.get(responseId);
				if (response) {
					this.pendingResponses.delete(responseId);
					logger.log('Responding with the stack trace');

					let stackFrames: StackFrame[] = [];
					for (let frame of frames) {
						stackFrames.push(new StackFrame(frame.index, frame.sourceText, new Source('krom.js', frame.originalSource), frame.originalLine, frame.originalColumn));
					}
					response.body = {
						stackFrames: stackFrames,
						totalFrames: frames.length
					};
					this.sendResponse(response);
				}
			}
			else if (data.readInt32LE(0) === KromDebugSession.IDE_MESSAGE_BREAK) {
				logger.log('Receiving a breakpoint even.');
				this.sendEvent(new StoppedEvent('breakpoint', KromDebugSession.THREAD_ID));
			}
		});

		this.socket.on('end', () => {

		});
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		//const path = <string>args.source.path;
		const clientLines = args.lines || [];

		const actualBreakpoints = clientLines.map(l => {
			let line = this.convertClientLineToDebugger(l);
			let path: string = args.source.path ? args.source.path : '';
			path = path.replace(/\\/g, '/');

			let pos = this.sourceMap.generatedPositionFor({
				source: 'file:///' + path.charAt(0).toUpperCase() + path.substr(1),
				line: line,
				column: 0
			});

			if (pos.line === null) {
				pos = this.sourceMap.generatedPositionFor({
					source: 'file:///' + path.charAt(0).toLowerCase() + path.substr(1),
					line: line,
					column: 0
				});
			}

			this.sendMessage([KromDebugSession.DEBUGGER_MESSAGE_BREAKPOINT, pos.line ? pos.line : 0]);

			let verified = true;
			let id = 0;
			const bp = <DebugProtocol.Breakpoint> new Breakpoint(verified, this.convertDebuggerLineToClient(line));
			bp.id= id;
			return bp;
		});

		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	private sendMessage(numbers: number[]): void {
		this.socket.write(Buffer.from(Int32Array.from(numbers).buffer));
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		this.sendMessage([KromDebugSession.DEBUGGER_MESSAGE_PAUSE]);
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: [
				new Thread(KromDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		logger.log('Request stack trace (seq ' + response.request_seq + ').');

		//const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		//const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		//const endFrame = startFrame + maxLevels;

		this.sendMessage([KromDebugSession.DEBUGGER_MESSAGE_STACKTRACE, response.request_seq]);
		this.pendingResponses.set(response.request_seq, response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		logger.log('Request scopes (seq ' + response.request_seq + ').');

		const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Local", this._variableHandles.create("local_" + frameReference), false));
		scopes.push(new Scope("Global", this._variableHandles.create("global_" + frameReference), true));

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		logger.log('Request variables (seq ' + response.request_seq + ').');
		const variables = new Array<DebugProtocol.Variable>();
		const id = this._variableHandles.get(args.variablesReference);
		if (id !== null) {
			variables.push({
				name: id + "_i",
				type: "integer",
				value: "123",
				variablesReference: 0
			});
			variables.push({
				name: id + "_f",
				type: "float",
				value: "3.14",
				variablesReference: 0
			});
			variables.push({
				name: id + "_s",
				type: "string",
				value: "hello world",
				variablesReference: 0
			});
			variables.push({
				name: id + "_o",
				type: "object",
				value: "Object",
				variablesReference: this._variableHandles.create("object_")
			});
		}

		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.sendMessage([KromDebugSession.DEBUGGER_MESSAGE_CONTINUE]);
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.sendMessage([KromDebugSession.DEBUGGER_MESSAGE_STEP_OVER]);
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.sendMessage([KromDebugSession.DEBUGGER_MESSAGE_STEP_IN]);
		this.sendResponse(response);
	}

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		let array = new Int32Array(1);
		array[0] = KromDebugSession.DEBUGGER_MESSAGE_STEP_OUT;
		this.socket.write(Buffer.from(array.buffer));
		this.sendResponse(response);
	}

	//---- helpers

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
	}
}
