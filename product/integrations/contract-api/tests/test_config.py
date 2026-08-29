import importlib.util
import os
import sys
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


CONFIG_PATH = Path(__file__).resolve().parents[1] / "app" / "config.py"


def load_config(environment: dict[str, str]):
    dotenv = types.ModuleType("dotenv")
    dotenv.load_dotenv = lambda *args, **kwargs: None
    module_name = f"contract_config_test_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(module_name, CONFIG_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load contract config module")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(os.environ, environment, clear=True), patch.dict(
        sys.modules, {"dotenv": dotenv}
    ):
        spec.loader.exec_module(module)
    return module


class ContractSecretNameTest(unittest.TestCase):
    def test_standard_uppercase_upstage_key_has_priority(self):
        config = load_config(
            {
                "UPSTAGE_API_KEY": "standard-secret",
                "Upstage_API_KEY": "legacy-secret",
            }
        )
        self.assertEqual(config.PROVIDERS["upstage"]["api_key"], "standard-secret")

    def test_legacy_upstage_key_remains_compatible(self):
        config = load_config({"Upstage_API_KEY": "legacy-secret"})
        self.assertEqual(config.PROVIDERS["upstage"]["api_key"], "legacy-secret")


if __name__ == "__main__":
    unittest.main()
