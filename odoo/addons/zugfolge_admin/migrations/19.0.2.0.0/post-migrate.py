import logging


_logger = logging.getLogger(__name__)


def migrate(_cr, _version):
    """Historical OAuth rows lack proof that email_verified was true."""
    _logger.info(
        "Zugfolge Keycloak subject backfill intentionally skipped; "
        "the next verified OIDC login binds each existing portal profile safely"
    )
