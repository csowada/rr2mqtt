"use strict";

const Roborock = require("./main");
const mqtt = require("mqtt");
const { version } = require("./package.json");

class Rr2MqttMain {

	constructor() {

		const that = this;
		this.localMqttUrl = process.env["LOCAL_MQTT"] || "undefined";
		this.localMqttPrefix = "rr2mqtt";

		this._logger = console;

		/** translate some mqtt values or use raw number values */
		this.translateMqttValues = false;

		/** @type {ReturnType<typeof Roborock>} */
		this.rradapter = Roborock({
			config: {
				username: process.env["RR_USERNAME"],
				password: process.env["RR_PASSWORD"],
				enable_map_creation: true,
				map_creation_interval: 60,
				updateInterval: 30,
			}
		});

		// submit all rr state updates to local mqtt
		this.rradapter.on("stateUpdate", (id, state) => {
			that.publishMqtt(id, state, "states");
		});

		// submit all rr object updates to local mqtt
		this.rradapter.on("objectUpdate", (id, state) => {
			that.publishMqtt(id, state, "objects");
		});

		// react on all rr subscript states via local mqtt
		this.rradapter.on("addMqttTopic", (t) => {
			const topic = `${that.localMqttPrefix}/${t}`;
			that.mqttClient.subscribe(topic);
		});

		this.mqttClient = mqtt.connect(this.localMqttUrl, {});
		this.mqttClient.on("message", this._onMessageCallback.bind(this));
		this.mqttClient.on("connect", () => {

			that._logger.info("Local MQTT client connected!");

			// submit ioBroker roborock adapter version
			this.mqttClient.publish(`${this.localMqttPrefix}/objects/version/iobroker-adapter`, (version || "unknown"));

			// submit all states after a connect
			Object.entries(that.rradapter.objects).forEach(([id, obj]) => {
				that.publishMqtt(id, obj, "objects");
			});

			// submit all objects after a connect
			Object.entries(that.rradapter.states).forEach(([id, state]) => {
				that.publishMqtt(id, state, "states");
			});
		});

		// mark rr as ready to start then program
		this.mqttClient.once("connect", () => {
			this.rradapter.emit("ready");
		});
	}

	/**
		* x
		* @param {string} topic x
		* @param {Buffer} message x
		*/
	_onMessageCallback(topic, message) {
		(async (topic, message) => {

			const data = JSON.parse(message.toString());

			this._logger.log(`TOPIC: ${topic} -> ${JSON.stringify(data)}`);

			const id = topic.replace(`${this.localMqttPrefix}/`, "").replaceAll("/", ".");
			const idSegments = id.split(".");
			const duid = idSegments[1];

			if (idSegments[0] === "Devices" && idSegments[2] === "commands") {
				const command = idSegments[3];
				await this._onCommand(command, data, duid);
			}

		})(topic, message).catch(error => {
			this._logger.error(error);
		});
	};

	/**
	 * Executes an command event
	 * @param {*} command Command id
	 * @param {*} data Payload data as object (JSON)
	 * @param {*} duid Device Id
	 */
	async _onCommand(command, data, duid) {
		if (command === "app_segment_clean") {
			const roomFloor = await this.rradapter.getStateAsync(`Devices.${duid}.deviceStatus.map_status`);

			if (!roomFloor) {
				throw new Error("No floor information available!");
			}

			const cleanCount = Math.min(Math.max(data.cleanCount, 1), 2);

			if (!Array.isArray(data.rooms)) {
				throw new Error(`Room numbers are not of type array!'`);
			}

			data.rooms.forEach(room => {
				if (!Number.isInteger(Number(room))) {
					throw new Error(`Room number '${room} is not a valid number!'`);
				}
			});

			// loop over all ioBroker objects and filter for the current floor and check if the rooms are in the payload
			for (const key of Object.keys(this.rradapter.objects)) {
				if (key.startsWith(`Devices.${duid}.floors.${roomFloor.val}.`)) {
					await this.rradapter.setStateAsync(key, data.rooms.includes(Number(key.split(".")[4])), true);
				}
			}

			// set the clean count
			await this.rradapter.setStateAsync(`Devices.${duid}.floors.cleanCount`, { val: cleanCount, ack: true });

			// replace to expected payload for original command handling
			data = true;
		}

		this.rradapter.setStateAsync(`Devices.${duid}.commands.${command}`, { val: data, ack: false }, false);
	}

	/**
	 * Submits a state or object to local mqtt broker
	 * @param {string} id ioBroker Id
	 * @param {{val: any, ack: boolean}} state ioBroker state
	 * @param {"objects" | "states"} type Type of message
	 */
	publishMqtt(id, state, type) {
		if (this.mqttClient && this.mqttClient.connected) {
			const key = id.replaceAll(".", "/");
			const topic = `${this.localMqttPrefix}/${type}/${key}`;

			if (type === "states") {

				if (!this.translateMqttValues) {
					this.mqttClient.publish(topic, JSON.stringify(state.val));

				} else {
					const obj = this.rradapter.objects[id];
					const rawValue = JSON.stringify(state.val);

					if (obj && obj.common && obj.common.states && obj.common.states[rawValue]) {
						this.mqttClient.publish(topic, obj.common.states[rawValue]);
					} else {
						this.mqttClient.publish(topic, JSON.stringify(state.val));
					}
				}
			} else {
				this.mqttClient.publish(topic, JSON.stringify(state));
			}
		}
	};

}

const main = async () => {
	new Rr2MqttMain();
};

main();