#!/usr/bin/env python3
# PiHRM — a fake BLE Heart Rate Monitor that FORCES bonding, to capture an Apple
# Watch's Identity Resolving Key (IRK) via BlueZ for Home Assistant Private BLE Device.
#
# How it works: the Watch's Settings -> Bluetooth -> Health Devices natively pairs to
# Heart Rate monitors (BLE Heart Rate Service 0x180D). We advertise that service, but
# the Heart Rate Measurement characteristic (0x2A37) is flagged "encrypt-read", so the
# moment the Watch tries to read it, BlueZ requires LE encryption -> the Watch must
# bond (Just Works, via the NoInputNoOutput agent below). On bond, watchOS distributes
# its IRK, which BlueZ writes to /var/lib/bluetooth/<adapter>/<watch>/info.
#
# Self-contained: registers an Agent (Just Works), a GATT app (HRS + encrypted HRM),
# and an LE advertisement named "PiHRM". Uses only system python3-dbus + python3-gi.
#
# Reads nothing it shouldn't and touches no other service config — it only adds an
# advertisement/agent on the shared adapter and sets it pairable/discoverable.

import dbus
import dbus.exceptions
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BLUEZ = 'org.bluez'
ADAPTER_IFACE = 'org.bluez.Adapter1'
GATT_MANAGER_IFACE = 'org.bluez.GattManager1'
LE_ADV_MANAGER_IFACE = 'org.bluez.LEAdvertisingManager1'
AGENT_MANAGER_IFACE = 'org.bluez.AgentManager1'
DBUS_OM_IFACE = 'org.freedesktop.DBus.ObjectManager'
DBUS_PROP_IFACE = 'org.freedesktop.DBus.Properties'
GATT_SERVICE_IFACE = 'org.bluez.GattService1'
GATT_CHRC_IFACE = 'org.bluez.GattCharacteristic1'
LE_ADVERTISEMENT_IFACE = 'org.bluez.LEAdvertisement1'
AGENT_IFACE = 'org.bluez.Agent1'
AGENT_PATH = '/pihrm/agent'

mainloop = None


class InvalidArgsException(dbus.exceptions.DBusException):
    _dbus_error_name = 'org.freedesktop.DBus.Error.InvalidArgs'


class NotSupportedException(dbus.exceptions.DBusException):
    _dbus_error_name = 'org.bluez.Error.NotSupported'


# ---------------------------------------------------------------- GATT application
class Application(dbus.service.Object):
    def __init__(self, bus):
        self.path = '/'
        self.services = []
        dbus.service.Object.__init__(self, bus, self.path)
        self.add_service(HeartRateService(bus, 0))

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def add_service(self, service):
        self.services.append(service)

    @dbus.service.method(DBUS_OM_IFACE, out_signature='a{oa{sa{sv}}}')
    def GetManagedObjects(self):
        response = {}
        for service in self.services:
            response[service.get_path()] = service.get_properties()
            for chrc in service.get_characteristics():
                response[chrc.get_path()] = chrc.get_properties()
        return response


class Service(dbus.service.Object):
    PATH_BASE = '/pihrm/service'

    def __init__(self, bus, index, uuid, primary):
        self.path = self.PATH_BASE + str(index)
        self.bus = bus
        self.uuid = uuid
        self.primary = primary
        self.characteristics = []
        dbus.service.Object.__init__(self, bus, self.path)

    def get_properties(self):
        return {GATT_SERVICE_IFACE: {
            'UUID': self.uuid,
            'Primary': self.primary,
            'Characteristics': dbus.Array(
                [c.get_path() for c in self.characteristics], signature='o'),
        }}

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def add_characteristic(self, chrc):
        self.characteristics.append(chrc)

    def get_characteristics(self):
        return self.characteristics

    @dbus.service.method(DBUS_PROP_IFACE, in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        if interface != GATT_SERVICE_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[GATT_SERVICE_IFACE]


class Characteristic(dbus.service.Object):
    def __init__(self, bus, index, uuid, flags, service):
        self.path = service.path + '/char' + str(index)
        self.bus = bus
        self.uuid = uuid
        self.flags = flags
        self.service = service
        dbus.service.Object.__init__(self, bus, self.path)

    def get_properties(self):
        return {GATT_CHRC_IFACE: {
            'Service': self.service.get_path(),
            'UUID': self.uuid,
            'Flags': self.flags,
        }}

    def get_path(self):
        return dbus.ObjectPath(self.path)

    @dbus.service.method(DBUS_PROP_IFACE, in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        if interface != GATT_CHRC_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[GATT_CHRC_IFACE]

    @dbus.service.method(GATT_CHRC_IFACE, in_signature='a{sv}', out_signature='ay')
    def ReadValue(self, options):
        # Heart Rate Measurement: flags byte 0x00 (uint8 bpm) + bpm value.
        print('HRM ReadValue from', options.get('device', '?'))
        return [dbus.Byte(0x00), dbus.Byte(60)]

    @dbus.service.method(GATT_CHRC_IFACE, in_signature='aya{sv}')
    def WriteValue(self, value, options):
        raise NotSupportedException()

    @dbus.service.method(GATT_CHRC_IFACE)
    def StartNotify(self):
        pass

    @dbus.service.method(GATT_CHRC_IFACE)
    def StopNotify(self):
        pass


class HeartRateService(Service):
    HR_UUID = '0000180d-0000-1000-8000-00805f9b34fb'

    def __init__(self, bus, index):
        Service.__init__(self, bus, index, self.HR_UUID, True)
        self.add_characteristic(HeartRateMeasurementChrc(bus, 0, self))


class HeartRateMeasurementChrc(Characteristic):
    HRM_UUID = '00002a37-0000-1000-8000-00805f9b34fb'

    def __init__(self, bus, index, service):
        # 'encrypt-read' forces LE encryption on read -> the central must bond.
        # With a NoInputNoOutput agent that bond is Just Works (no MITM), which is
        # all we need: the IRK is exchanged during LE key distribution regardless.
        Characteristic.__init__(self, bus, index, self.HRM_UUID,
                                ['encrypt-read', 'notify'], service)


# ---------------------------------------------------------------- advertisement
class Advertisement(dbus.service.Object):
    PATH_BASE = '/pihrm/advertisement'

    def __init__(self, bus, index):
        self.path = self.PATH_BASE + str(index)
        self.bus = bus
        dbus.service.Object.__init__(self, bus, self.path)

    def get_properties(self):
        return {LE_ADVERTISEMENT_IFACE: {
            'Type': 'peripheral',
            'ServiceUUIDs': dbus.Array(['180D'], signature='s'),
            'LocalName': dbus.String('PiHRM'),
            'Discoverable': dbus.Boolean(True),
            'IncludeTxPower': dbus.Boolean(True),
        }}

    def get_path(self):
        return dbus.ObjectPath(self.path)

    @dbus.service.method(DBUS_PROP_IFACE, in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        if interface != LE_ADVERTISEMENT_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[LE_ADVERTISEMENT_IFACE]

    @dbus.service.method(LE_ADVERTISEMENT_IFACE, in_signature='', out_signature='')
    def Release(self):
        print('Advertisement released')


# ---------------------------------------------------------------- agent (Just Works)
class Agent(dbus.service.Object):
    @dbus.service.method(AGENT_IFACE, in_signature='', out_signature='')
    def Release(self):
        pass

    @dbus.service.method(AGENT_IFACE, in_signature='os', out_signature='')
    def AuthorizeService(self, device, uuid):
        print('AuthorizeService', device, uuid)
        return

    @dbus.service.method(AGENT_IFACE, in_signature='o', out_signature='')
    def RequestAuthorization(self, device):
        print('RequestAuthorization (accepting):', device)
        return

    @dbus.service.method(AGENT_IFACE, in_signature='o', out_signature='s')
    def RequestPinCode(self, device):
        return '0000'

    @dbus.service.method(AGENT_IFACE, in_signature='o', out_signature='u')
    def RequestPasskey(self, device):
        return dbus.UInt32(0)

    @dbus.service.method(AGENT_IFACE, in_signature='ou', out_signature='')
    def RequestConfirmation(self, device, passkey):
        print('RequestConfirmation (accepting):', device, passkey)
        return

    @dbus.service.method(AGENT_IFACE, in_signature='ouq', out_signature='')
    def DisplayPasskey(self, device, passkey, entered):
        print('DisplayPasskey', device, passkey)

    @dbus.service.method(AGENT_IFACE, in_signature='os', out_signature='')
    def DisplayPinCode(self, device, pincode):
        print('DisplayPinCode', device, pincode)

    @dbus.service.method(AGENT_IFACE, in_signature='', out_signature='')
    def Cancel(self):
        print('Pairing cancelled by remote')


# ---------------------------------------------------------------- main
def find_adapter(bus):
    om = dbus.Interface(bus.get_object(BLUEZ, '/'), DBUS_OM_IFACE)
    for path, ifaces in om.GetManagedObjects().items():
        if GATT_MANAGER_IFACE in ifaces and LE_ADV_MANAGER_IFACE in ifaces:
            return path
    return None


def main():
    global mainloop
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()

    adapter = find_adapter(bus)
    if not adapter:
        print('FATAL: no adapter exposing GattManager1 + LEAdvertisingManager1')
        return
    print('Using adapter:', adapter)

    props = dbus.Interface(bus.get_object(BLUEZ, adapter), DBUS_PROP_IFACE)
    props.Set(ADAPTER_IFACE, 'Powered', dbus.Boolean(True))
    props.Set(ADAPTER_IFACE, 'Pairable', dbus.Boolean(True))
    props.Set(ADAPTER_IFACE, 'PairableTimeout', dbus.UInt32(0))
    props.Set(ADAPTER_IFACE, 'DiscoverableTimeout', dbus.UInt32(0))
    props.Set(ADAPTER_IFACE, 'Discoverable', dbus.Boolean(True))
    print('Adapter set: powered, pairable, discoverable (no timeout).')

    agent = Agent(bus, AGENT_PATH)
    am = dbus.Interface(bus.get_object(BLUEZ, '/org/bluez'), AGENT_MANAGER_IFACE)
    am.RegisterAgent(AGENT_PATH, 'NoInputNoOutput')
    am.RequestDefaultAgent(AGENT_PATH)
    print('Agent registered: NoInputNoOutput (Just Works), default.')

    app = Application(bus)
    gm = dbus.Interface(bus.get_object(BLUEZ, adapter), GATT_MANAGER_IFACE)
    gm.RegisterApplication(
        app.get_path(), {},
        reply_handler=lambda: print('GATT app registered (HRS 0x180D, HRM encrypt-read).'),
        error_handler=lambda e: print('GATT register ERROR:', e))

    adv = Advertisement(bus, 0)
    lm = dbus.Interface(bus.get_object(BLUEZ, adapter), LE_ADV_MANAGER_IFACE)
    lm.RegisterAdvertisement(
        adv.get_path(), {},
        reply_handler=lambda: print('Advertising as "PiHRM" (service 0x180D).'),
        error_handler=lambda e: print('Advertisement register ERROR:', e))

    mainloop = GLib.MainLoop()
    print('--- PiHRM running. Bond from the Apple Watch now. Ctrl-C / SIGTERM to stop. ---',
          flush=True)
    try:
        mainloop.run()
    except KeyboardInterrupt:
        print('Stopping.')


if __name__ == '__main__':
    main()
